import { createHash } from 'crypto';
import type { Keypair } from '@stellar/stellar-sdk';
import { NotFoundError } from '@offerhub/sdk';
import type { OfferHubSDK, Payout, PayoutStatus } from '@offerhub/sdk';
import type { Corridor } from './config';
import type { LedgerReader } from './ledger';
import { toStroops } from './ledger';
import { confirmTransaction, ConfirmationError, transactionHash } from './confirm';
import { signMessage, signTransactionXdr } from './signing';
import { BLINDPAY_PENDING, buildReceipt, type BlindPayPayoutView, type DisbursementReader } from './blindpay';
import { StepFailure } from './types';
import type { DisbursementReceipt, StepOutcome, TxConfirmation, ValidationStep } from './types';

/** The SDK surface the scenario uses — narrow so tests can fake it. */
export type AuthClient = Pick<OfferHubSDK, 'auth' | 'asUser'>;
export type UserClient = Pick<OfferHubSDK, 'orders' | 'escrow' | 'resolution' | 'payouts'>;

export interface ScenarioContext {
    runId: string;
    corridor: Corridor;
    amountUsdc: string;
    minBalanceUsdc: string;
    networkPassphrase: string;
    buyerKeypair: Keypair;
    sellerKeypair: Keypair;
    api: AuthClient;
    ledger: LedgerReader;
    blindpay: DisbursementReader;
    payoutTimeoutMs: number;
    pollIntervalMs: number;
    confirmTimeoutMs: number;
    confirmPollIntervalMs: number;
    sleep: (ms: number) => Promise<void>;
    now: () => number;

    // Filled in as the scenario advances
    buyer?: { id: string; client: UserClient };
    seller?: { id: string; client: UserClient };
    orderId?: string;
    contractId?: string;
    payoutId?: string;
    blindpayPayoutId?: string;
    payoutTxHash?: string;
    receipt?: DisbursementReceipt;
}

/** Hard cap on release steps: the contract needs 3 (complete, approve, release). */
const MAX_RELEASE_STEPS = 6;

const PAYOUT_SETTLED: PayoutStatus[] = ['COMPLETED'];
const PAYOUT_DEAD: PayoutStatus[] = ['FAILED', 'REFUNDED', 'ON_HOLD'];

function must<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`${what} is not available: an earlier step did not complete`);
    return value;
}

/**
 * Idempotency key for one step of one run. The API only accepts UUID v4 keys
 * (IdempotencyGuard), so the run id and step are hashed into one: the same
 * step of the same run always gets the same key, which is what makes a
 * retried request safe, and different steps or runs never collide.
 */
export function idempotencyKeyFor(runId: string, step: string): string {
    const bytes = createHash('sha256').update(`validation:${runId}:${step}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idem(ctx: ScenarioContext, step: string): { idempotencyKey: string } {
    return { idempotencyKey: idempotencyKeyFor(ctx.runId, step) };
}

/**
 * Collects the transactions a step submits and confirms each one on-chain
 * right after the API accepts it (#316). If anything throws, the transactions
 * recorded so far still reach the report.
 */
class TxTracker {
    readonly txHashes: string[] = [];
    readonly confirmations: TxConfirmation[] = [];

    constructor(private readonly ctx: ScenarioContext) {}

    /**
     * `signedXdr` is what we signed; `apiHash` is what the API says it
     * submitted (when it reports one). They must match: that proves the API
     * put our transaction on-chain unchanged.
     */
    async submitted(signedXdr: string, apiHash?: string): Promise<void> {
        const hash = transactionHash(signedXdr, this.ctx.networkPassphrase);
        if (apiHash !== undefined && apiHash !== hash) {
            throw new Error(`API reported transaction ${apiHash} but the signed transaction is ${hash}`);
        }
        this.txHashes.push(hash);
        try {
            this.confirmations.push(
                await confirmTransaction(this.ctx.ledger, hash, {
                    timeoutMs: this.ctx.confirmTimeoutMs,
                    pollIntervalMs: this.ctx.confirmPollIntervalMs,
                    sleep: this.ctx.sleep,
                    now: this.ctx.now,
                }),
            );
        } catch (error: unknown) {
            if (error instanceof ConfirmationError) this.confirmations.push(error.confirmation);
            throw error;
        }
    }

    outcome(extra: Omit<StepOutcome, 'txHashes' | 'confirmations'> = {}): StepOutcome {
        return { ...extra, txHashes: [...this.txHashes], confirmations: [...this.confirmations] };
    }
}

/** Runs `body` with a tracker; a failure carries the partial transactions to the report. */
async function tracked(ctx: ScenarioContext, body: (t: TxTracker) => Promise<StepOutcome>): Promise<StepOutcome> {
    const t = new TxTracker(ctx);
    try {
        return await body(t);
    } catch (error: unknown) {
        throw new StepFailure(error instanceof Error ? error.message : String(error), t.outcome());
    }
}

async function signIn(ctx: ScenarioContext, keypair: Keypair): Promise<{ id: string; client: UserClient }> {
    const publicKey = keypair.publicKey();
    const { challenge } = await ctx.api.auth.walletChallenge(publicKey);
    const session = await ctx.api.auth.walletVerify({
        publicKey,
        challenge,
        signature: signMessage(keypair, challenge),
    });
    return { id: session.user.id, client: ctx.api.asUser(session.token) };
}

const preflight: ValidationStep<ScenarioContext> = {
    name: 'preflight',
    async run(ctx) {
        const balance = await ctx.ledger.usdcBalance(ctx.buyerKeypair.publicKey());
        if (balance === null) throw new Error('Buyer wallet has no USDC trustline (or the account does not exist)');
        const floor = toStroops(ctx.minBalanceUsdc);
        const needed = toStroops(ctx.amountUsdc);
        if (toStroops(balance) < floor || toStroops(balance) < needed) {
            throw new Error(
                `Buyer USDC balance ${balance} is below the floor (${ctx.minBalanceUsdc}) or the run amount (${ctx.amountUsdc}); refusing to start`,
            );
        }
        return { details: { buyerUsdcBalance: balance } };
    },
};

const authenticate: ValidationStep<ScenarioContext> = {
    name: 'authenticate',
    async run(ctx) {
        ctx.buyer = await signIn(ctx, ctx.buyerKeypair);
        ctx.seller = await signIn(ctx, ctx.sellerKeypair);
        return { details: { buyerId: ctx.buyer.id, sellerId: ctx.seller.id } };
    },
};

const createOrder: ValidationStep<ScenarioContext> = {
    name: 'create_order',
    async run(ctx) {
        const buyer = must(ctx.buyer, 'Buyer session');
        const seller = must(ctx.seller, 'Seller session');
        const order = await buyer.client.orders.create(
            {
                buyer_id: buyer.id,
                seller_id: seller.id,
                amount: ctx.amountUsdc,
                title: `[validation] ${ctx.corridor} run ${ctx.runId}`,
                description: 'Automated production validation run (OfferHub validation framework). Not a real job.',
                client_order_ref: `validation-${ctx.runId}`,
                milestones: [{ milestone_ref: 'validation', title: 'Validation milestone', amount: ctx.amountUsdc }],
                metadata: { validation: true, runId: ctx.runId, corridor: ctx.corridor },
            },
            idem(ctx, 'order'),
        );
        ctx.orderId = order.id;
        return { details: { orderId: order.id } };
    },
};

const createEscrow: ValidationStep<ScenarioContext> = {
    name: 'escrow_create',
    async run(ctx) {
        const buyer = must(ctx.buyer, 'Buyer session');
        const orderId = must(ctx.orderId, 'Order');
        return tracked(ctx, async (t) => {
            const prepared = await buyer.client.escrow.prepareCreate(orderId);
            const signed = signTransactionXdr(ctx.buyerKeypair, prepared.unsignedXdr, ctx.networkPassphrase);
            const result = await buyer.client.escrow.submit(orderId, 'create', signed, idem(ctx, 'escrow-create'));
            ctx.contractId = result.order.escrow?.trustlessContractId ?? undefined;
            await t.submitted(signed, result.transactionHash);
            return t.outcome({ details: { contractId: ctx.contractId } });
        });
    },
};

const fundEscrow: ValidationStep<ScenarioContext> = {
    name: 'escrow_fund',
    async run(ctx) {
        const buyer = must(ctx.buyer, 'Buyer session');
        const orderId = must(ctx.orderId, 'Order');
        return tracked(ctx, async (t) => {
            const prepared = await buyer.client.escrow.prepareFund(orderId);
            const signed = signTransactionXdr(ctx.buyerKeypair, prepared.unsignedXdr, ctx.networkPassphrase);
            const result = await buyer.client.escrow.submit(orderId, 'fund', signed, idem(ctx, 'escrow-fund'));
            await t.submitted(signed, result.transactionHash);
            return t.outcome({ details: { orderStatus: result.order.status } });
        });
    },
};

/**
 * Walks the release sequence the way the frontend does: ask the API for the
 * next step, sign it with whichever party it names, submit, repeat.
 */
const release: ValidationStep<ScenarioContext> = {
    name: 'escrow_release',
    async run(ctx) {
        const buyer = must(ctx.buyer, 'Buyer session');
        const seller = must(ctx.seller, 'Seller session');
        const orderId = must(ctx.orderId, 'Order');
        const parties = {
            buyer: { client: buyer.client, keypair: ctx.buyerKeypair },
            seller: { client: seller.client, keypair: ctx.sellerKeypair },
        };

        return tracked(ctx, async (t) => {
            const sequence: string[] = [];
            let next = await buyer.client.resolution.prepareRelease(orderId);
            while (next.unsignedXdr) {
                if (sequence.length >= MAX_RELEASE_STEPS) {
                    throw new Error(`Release did not finish after ${MAX_RELEASE_STEPS} steps: ${sequence.join(' → ')}`);
                }
                if (!next.signer) throw new Error(`Release step ${next.step ?? '?'} names no signer`);
                const party = parties[next.signer];
                const signed = signTransactionXdr(party.keypair, next.unsignedXdr, ctx.networkPassphrase);
                const submitted = await party.client.escrow.submit(
                    orderId,
                    'release',
                    signed,
                    idem(ctx, `release-${sequence.length}`),
                );
                sequence.push(`${next.step}:${next.signer}`);
                // Confirm before asking for the next step: each one builds on the previous ledger state
                await t.submitted(signed, submitted.transactionHash);
                next = await party.client.resolution.prepareRelease(orderId);
            }
            if (sequence.length === 0) throw new Error('Release returned no steps to sign');
            return t.outcome({ details: { sequence } });
        });
    },
};

async function waitForPayout(
    ctx: ScenarioContext,
    client: UserClient,
    orderId: string,
    done: (p: Payout) => boolean,
    label: string,
): Promise<Payout> {
    const deadline = ctx.now() + ctx.payoutTimeoutMs;
    for (;;) {
        let payout: Payout | undefined;
        try {
            payout = await client.payouts.get(orderId);
        } catch (error: unknown) {
            // The payout row is created by the orchestration layer right after the release; it can lag a poll or two
            if (!isNotFound(error)) throw error;
        }
        if (payout) {
            if (PAYOUT_DEAD.includes(payout.status)) {
                throw new Error(
                    `Payout ${payout.id} ended ${payout.status}${payout.failureReason ? `: ${payout.failureReason}` : ''}`,
                );
            }
            if (done(payout)) return payout;
        }
        if (ctx.now() >= deadline) {
            throw new Error(
                `Timed out after ${ctx.payoutTimeoutMs}ms waiting for the payout to ${label} (last status: ${payout?.status ?? 'none'})`,
            );
        }
        await ctx.sleep(ctx.pollIntervalMs);
    }
}

function isNotFound(error: unknown): boolean {
    return error instanceof NotFoundError;
}

/** Seller signs the USDC transfer to BlindPay's deposit address, as the frontend does. */
const payoutTransfer: ValidationStep<ScenarioContext> = {
    name: 'payout_transfer',
    async run(ctx) {
        const seller = must(ctx.seller, 'Seller session');
        const orderId = must(ctx.orderId, 'Order');
        return tracked(ctx, async (t) => {
            await waitForPayout(
                ctx,
                seller.client,
                orderId,
                (p) => p.status === 'AWAITING_SIGNATURE',
                'await the seller signature',
            );
            const transfer = await seller.client.payouts.prepare(orderId);
            const signed = signTransactionXdr(ctx.sellerKeypair, transfer.unsignedXdr, ctx.networkPassphrase);
            const payout = await seller.client.payouts.submit(
                orderId,
                { signedXdr: signed, quoteId: transfer.quoteId },
                idem(ctx, 'payout-submit'),
            );
            ctx.payoutId = payout.id;
            // The payout API doesn't echo a hash; the locally computed one is confirmed directly
            await t.submitted(signed);
            ctx.payoutTxHash = t.txHashes[t.txHashes.length - 1];
            return t.outcome({
                payoutId: payout.id,
                details: {
                    payoutStatus: payout.status,
                    corridor: payout.corridor,
                    usdcAmount: transfer.usdcAmount,
                    fiatAmount: transfer.fiatAmount,
                    fiatCurrency: payout.fiatCurrency,
                },
            });
        });
    },
};

/** Waits for BlindPay to report the fiat disbursement as completed. */
const payoutSettlement: ValidationStep<ScenarioContext> = {
    name: 'payout_settlement',
    async run(ctx) {
        const seller = must(ctx.seller, 'Seller session');
        const orderId = must(ctx.orderId, 'Order');
        const payout = await waitForPayout(
            ctx,
            seller.client,
            orderId,
            (p) => PAYOUT_SETTLED.includes(p.status),
            'complete',
        );
        if (!payout.blindpayPayoutId) throw new Error(`Payout ${payout.id} is COMPLETED but carries no BlindPay payout id`);
        ctx.blindpayPayoutId = payout.blindpayPayoutId;
        return {
            payoutId: payout.id,
            details: {
                payoutStatus: payout.status,
                blindpayPayoutId: payout.blindpayPayoutId,
                fiatAmount: payout.fiatAmount,
                fiatCurrency: payout.fiatCurrency,
            },
        };
    },
};

/**
 * Reads the payout straight from BlindPay (#317) and turns it into the run's
 * receipt: the disbursement only counts once BlindPay itself says `completed`,
 * in the corridor's currency.
 */
const disbursementVerification: ValidationStep<ScenarioContext> = {
    name: 'disbursement_verification',
    async run(ctx) {
        const blindpayPayoutId = must(ctx.blindpayPayoutId, 'BlindPay payout id');
        const deadline = ctx.now() + ctx.payoutTimeoutMs;
        let view: BlindPayPayoutView;
        for (;;) {
            view = await ctx.blindpay.getPayout(blindpayPayoutId);
            // The webhook can reach OfferHub a moment before BlindPay's own read model catches up
            if (!BLINDPAY_PENDING.includes(view.status)) break;
            if (ctx.now() >= deadline) {
                throw new Error(`BlindPay still reports payout ${blindpayPayoutId} as ${view.status} after ${ctx.payoutTimeoutMs}ms`);
            }
            await ctx.sleep(ctx.pollIntervalMs);
        }
        const receipt = buildReceipt(view, {
            corridor: ctx.corridor,
            payoutTxHash: ctx.payoutTxHash,
            verifiedAt: new Date(ctx.now()).toISOString(),
        });
        ctx.receipt = receipt;
        return { payoutId: ctx.payoutId, details: { receipt } };
    },
};

/** The full escrow → fiat cycle, in order. A failed step stops the run. */
export const ESCROW_TO_FIAT_SCENARIO: ValidationStep<ScenarioContext>[] = [
    preflight,
    authenticate,
    createOrder,
    createEscrow,
    fundEscrow,
    release,
    payoutTransfer,
    payoutSettlement,
    disbursementVerification,
];

export type { StepOutcome };
