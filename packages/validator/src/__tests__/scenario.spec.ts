import { Account, Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { NotFoundError } from '@offerhub/sdk';
import type { Payout, PayoutStatus } from '@offerhub/sdk';
import { ESCROW_TO_FIAT_SCENARIO, idempotencyKeyFor, type AuthClient, type ScenarioContext } from '../scenario';
import { runScenario } from '../runner';
import type { LedgerReader, TxLookup } from '../ledger';
import { transactionHash } from '../confirm';
import type { BlindPayPayoutView, DisbursementReader } from '../blindpay';

function blindpayPayout(overrides: Partial<BlindPayPayoutView> = {}): BlindPayPayoutView {
    return {
        id: 'po_1',
        status: 'completed',
        currency: 'MXN',
        sender_amount: 500,
        receiver_amount: 9000,
        tracking_transaction: { status: 'completed', transaction_hash: null, completed_at: '2026-11-10T10:00:00Z' },
        tracking_payment: { provider_name: 'SPEI', provider_transaction_id: 'SPEI123', provider_status: 'paid', completed_at: '2026-11-10T10:04:00Z' },
        tracking_complete: { status: 'completed', transaction_hash: null, completed_at: '2026-11-10T10:05:00Z' },
        updated_at: '2026-11-10T10:05:01Z',
        ...overrides,
    };
}

/** BlindPay answers from `answers` in order, repeating the last one. */
function fakeBlindPay(...answers: Array<Partial<BlindPayPayoutView> | ((id: string) => BlindPayPayoutView)>) {
    const calls: string[] = [];
    const reader: DisbursementReader = {
        getPayout: async (id) => {
            calls.push(id);
            const a = answers.length ? answers[Math.min(calls.length - 1, answers.length - 1)] : {};
            return typeof a === 'function' ? a(id) : blindpayPayout(a);
        },
    };
    return { reader, calls };
}

const PASSPHRASE = Networks.PUBLIC;

/** A real unsigned transaction, so the scenario's signing code runs for real. */
function unsignedXdr(source: Keypair): string {
    return new TransactionBuilder(new Account(source.publicKey(), '1'), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
        .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
        .setTimeout(300)
        .build()
        .toXDR();
}

function signerOf(signedXdr: string): string[] {
    return TransactionBuilder.fromXDR(signedXdr, PASSPHRASE).signatures.map((s) => s.hint().toString('hex'));
}

interface FakeOptions {
    /** Make the API report a different hash than the one it was given */
    lieAboutHash?: boolean;
    payoutStatuses?: PayoutStatus[];
    payoutMissingPolls?: number;
    releaseSteps?: Array<{ step: string; signer: 'buyer' | 'seller' }>;
}

/**
 * Minimal stand-in for the OfferHub API that tracks who signed what. Each
 * user client only knows its own identity, like a real session would.
 */
function createFakeApi(buyer: Keypair, seller: Keypair, opts: FakeOptions = {}) {
    const users = new Map([
        [buyer.publicKey(), 'usr_buyer'],
        [seller.publicKey(), 'usr_seller'],
    ]);
    const keyOf = { usr_buyer: buyer, usr_seller: seller } as Record<string, Keypair>;
    const submitted: Array<{ by: string; operation: string; hints: string[] }> = [];
    const idempotencyKeys: string[] = [];
    const releaseSteps = [...(opts.releaseSteps ?? [
        { step: 'complete_milestone', signer: 'seller' as const },
        { step: 'approve_milestone', signer: 'buyer' as const },
        { step: 'release', signer: 'buyer' as const },
    ])];
    const payoutStatuses = [...(opts.payoutStatuses ?? ['AWAITING_SIGNATURE', 'PROCESSING', 'COMPLETED'])];
    let missingPolls = opts.payoutMissingPolls ?? 0;
    let payoutStatus: PayoutStatus = payoutStatuses[0];

    const payout = (): Payout =>
        ({ id: 'pay_1', orderId: 'ord_1', status: payoutStatus, corridor: 'MX/SPEI', fiatCurrency: 'MXN', fiatAmount: '90.00', blindpayPayoutId: 'po_1', failureReason: payoutStatus === 'FAILED' ? 'Bank account rejected' : null }) as Payout;

    const client = (userId: string) => ({
        orders: {
            create: jest.fn(async (data: { buyer_id: string; seller_id: string }, o: { idempotencyKey: string }) => {
                idempotencyKeys.push(o.idempotencyKey);
                expect(data).toMatchObject({ buyer_id: 'usr_buyer', seller_id: 'usr_seller' });
                return { id: 'ord_1', status: 'ORDER_CREATED' };
            }),
        },
        escrow: {
            prepareCreate: jest.fn(async () => ({ unsignedXdr: unsignedXdr(keyOf[userId]) })),
            prepareFund: jest.fn(async () => ({ unsignedXdr: unsignedXdr(keyOf[userId]) })),
            submit: jest.fn(async (_orderId: string, operation: string, signed: string, o: { idempotencyKey: string }) => {
                idempotencyKeys.push(o.idempotencyKey);
                submitted.push({ by: userId, operation, hints: signerOf(signed) });
                if (operation === 'release') releaseSteps.shift();
                if (operation === 'release' && releaseSteps.length === 0) payoutStatus = payoutStatuses[0];
                const hash = opts.lieAboutHash ? 'f'.repeat(64) : transactionHash(signed, PASSPHRASE);
                return { transactionHash: hash, order: { status: 'IN_PROGRESS', escrow: { trustlessContractId: 'CCONTRACT' } } };
            }),
        },
        resolution: {
            prepareRelease: jest.fn(async () => {
                const next = releaseSteps[0];
                if (!next) return { step: null, signer: null, unsignedXdr: null };
                return { step: next.step, signer: next.signer, unsignedXdr: unsignedXdr(next.signer === 'buyer' ? buyer : seller) };
            }),
        },
        payouts: {
            get: jest.fn(async () => {
                if (missingPolls > 0) {
                    missingPolls--;
                    throw new NotFoundError('Payout not found');
                }
                const current = payout();
                // Each poll after the signature advances the status, like BlindPay's webhooks would
                if (payoutStatus !== 'AWAITING_SIGNATURE' && payoutStatuses.length > 1) {
                    payoutStatuses.shift();
                    payoutStatus = payoutStatuses[0];
                }
                return current;
            }),
            prepare: jest.fn(async () => ({ quoteId: 'qt_1', unsignedXdr: unsignedXdr(seller), usdcAmount: '5.00', fiatAmount: '90.00' })),
            submit: jest.fn(async (_orderId: string, data: { signedXdr: string; quoteId: string }, o: { idempotencyKey: string }) => {
                idempotencyKeys.push(o.idempotencyKey);
                submitted.push({ by: userId, operation: 'payout', hints: signerOf(data.signedXdr) });
                payoutStatuses.shift();
                payoutStatus = payoutStatuses[0];
                return payout();
            }),
        },
    });

    const api = {
        auth: {
            walletChallenge: jest.fn(async () => ({ challenge: 'nonce', expiresIn: 300 })),
            walletVerify: jest.fn(async ({ publicKey }: { publicKey: string }) => ({ user: { id: users.get(publicKey) }, token: `jwt-${users.get(publicKey)}` })),
        },
        asUser: jest.fn((token: string) => client(token.replace('jwt-', ''))),
    } as unknown as AuthClient;

    return { api, submitted, idempotencyKeys };
}

function hint(k: Keypair): string {
    return k.rawPublicKey().subarray(28).toString('hex');
}

/**
 * Fake ledger: every transaction is found on the second poll unless
 * `lookups` overrides the answer for it (by submission order).
 */
function fakeLedger(balance: string | null, lookups: Record<number, TxLookup | 'throw'> = {}) {
    const seen = new Map<string, number>();
    const order: string[] = [];
    const ledger: LedgerReader = {
        usdcBalance: async () => balance,
        getTransaction: async (hash) => {
            if (!order.includes(hash)) order.push(hash);
            const polls = (seen.get(hash) ?? 0) + 1;
            seen.set(hash, polls);
            const override = lookups[order.indexOf(hash)];
            if (override === 'throw') throw new Error('RPC 503');
            if (override) return override;
            return polls < 2 ? { status: 'NOT_FOUND' } : { status: 'SUCCESS', ledger: 1000 + order.indexOf(hash), closedAtUnix: 1_763_000_000 };
        },
    };
    return { ledger, order };
}

function context(api: AuthClient, ledgerBalance: string | null, overrides: Partial<ScenarioContext> = {}): ScenarioContext {
    let clock = 0;
    return {
        runId: 'vr_test',
        corridor: 'MX',
        amountUsdc: '5.00',
        minBalanceUsdc: '10',
        networkPassphrase: PASSPHRASE,
        buyerKeypair: buyerKp,
        sellerKeypair: sellerKp,
        api,
        ledger: fakeLedger(ledgerBalance).ledger,
        blindpay: fakeBlindPay().reader,
        payoutTimeoutMs: 60_000,
        pollIntervalMs: 10_000,
        confirmTimeoutMs: 30_000,
        confirmPollIntervalMs: 1_000,
        sleep: async (ms) => {
            clock += ms;
        },
        now: () => clock,
        ...overrides,
    };
}

const buyerKp = Keypair.random();
const sellerKp = Keypair.random();
const meta = { id: 'vr_test', network: 'mainnet' as const, apiUrl: 'https://api', corridor: 'MX', trigger: 'manual' as const };

describe('escrow → fiat scenario', () => {
    it('runs the whole cycle, each transaction signed by the right wallet', async () => {
        const fake = createFakeApi(buyerKp, sellerKp, { payoutMissingPolls: 1 });
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, '50.0000000'), meta);

        expect(report.status).toBe('passed');
        expect(report.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
            'preflight:passed',
            'authenticate:passed',
            'create_order:passed',
            'escrow_create:passed',
            'escrow_fund:passed',
            'escrow_release:passed',
            'payout_transfer:passed',
            'payout_settlement:passed',
            'disbursement_verification:passed',
        ]);
        expect(report.orderId).toBe('ord_1');
        expect(report.contractId).toBe('CCONTRACT');

        expect(fake.submitted.map((s) => `${s.operation}:${s.by}`)).toEqual([
            'create:usr_buyer',
            'fund:usr_buyer',
            'release:usr_seller',
            'release:usr_buyer',
            'release:usr_buyer',
            'payout:usr_seller',
        ]);
        const expectedSigner = { usr_buyer: hint(buyerKp), usr_seller: hint(sellerKp) } as Record<string, string>;
        for (const s of fake.submitted) expect(s.hints).toEqual([expectedSigner[s.by]]);

        const releaseStep = report.steps.find((s) => s.name === 'escrow_release')!;
        expect(releaseStep.txHashes).toHaveLength(3);
        expect(releaseStep.details).toEqual({ sequence: ['complete_milestone:seller', 'approve_milestone:buyer', 'release:buyer'] });
        expect(report.steps.find((s) => s.name === 'payout_settlement')!.payoutId).toBe('pay_1');
    });

    it('derives every idempotency key from the run id, so a retried call is never applied twice', async () => {
        const fake = createFakeApi(buyerKp, sellerKp);
        await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, '50'), meta);

        // IdempotencyGuard only accepts UUID v4
        const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        expect(fake.idempotencyKeys.every((k) => uuidV4.test(k))).toBe(true);
        expect(fake.idempotencyKeys[0]).toBe(idempotencyKeyFor('vr_test', 'order'));
        expect(new Set(fake.idempotencyKeys).size).toBe(fake.idempotencyKeys.length);
    });

    it('refuses to start below the balance floor and skips everything else', async () => {
        const fake = createFakeApi(buyerKp, sellerKp);
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, '9.9999999'), meta);

        expect(report.status).toBe('failed');
        expect(report.steps[0]).toMatchObject({ name: 'preflight', status: 'failed' });
        expect(report.steps[0].error).toMatch(/below the floor/);
        expect(report.steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
        expect(fake.submitted).toEqual([]);
    });

    it('fails preflight when the buyer has no USDC trustline', async () => {
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(createFakeApi(buyerKp, sellerKp).api, null), meta);
        expect(report.steps[0].error).toMatch(/trustline/);
    });

    it('reports a payout that BlindPay rejects as a failed settlement with the reason', async () => {
        const fake = createFakeApi(buyerKp, sellerKp, { payoutStatuses: ['AWAITING_SIGNATURE', 'PROCESSING', 'FAILED'] });
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, '50'), meta);

        const settlement = report.steps.find((s) => s.name === 'payout_settlement')!;
        expect(report.status).toBe('failed');
        expect(settlement.status).toBe('failed');
        expect(settlement.error).toMatch(/FAILED: Bank account rejected/);
    });

    it('times out a payout that never settles instead of waiting forever', async () => {
        const fake = createFakeApi(buyerKp, sellerKp, { payoutStatuses: ['AWAITING_SIGNATURE', 'PROCESSING'] });
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, '50', { payoutTimeoutMs: 30_000 }), meta);

        const settlement = report.steps.find((s) => s.name === 'payout_settlement')!;
        expect(settlement.status).toBe('failed');
        expect(settlement.error).toMatch(/Timed out .* \(last status: PROCESSING\)/);
    });

    it('stops a release that never finishes', async () => {
        const endless = Array.from({ length: 10 }, () => ({ step: 'approve_milestone', signer: 'buyer' as const }));
        const fake = createFakeApi(buyerKp, sellerKp, { releaseSteps: endless });
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, '50'), meta);

        const releaseStep = report.steps.find((s) => s.name === 'escrow_release')!;
        expect(releaseStep.status).toBe('failed');
        expect(releaseStep.error).toMatch(/did not finish after 6 steps/);
    });

    it('confirms every submitted transaction on-chain over RPC, including the payout transfer', async () => {
        const fake = createFakeApi(buyerKp, sellerKp);
        const { ledger, order } = fakeLedger('50');
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, null, { ledger }), meta);

        expect(report.status).toBe('passed');
        const onChain = report.steps.filter((s) => s.txHashes.length > 0);
        expect(onChain.map((s) => `${s.name}:${s.txHashes.length}`)).toEqual([
            'escrow_create:1',
            'escrow_fund:1',
            'escrow_release:3',
            'payout_transfer:1',
        ]);
        for (const step of onChain) {
            expect(step.confirmations.map((c) => c.hash)).toEqual(step.txHashes);
            for (const c of step.confirmations) {
                expect(c).toMatchObject({ status: 'SUCCESS', polls: 2, confirmedInMs: 1_000 });
                expect(c.ledgerClosedAt).toBe(new Date(1_763_000_000 * 1000).toISOString());
            }
        }
        // 6 distinct transactions looked up, in submission order
        expect(order).toHaveLength(6);
        expect(order).toEqual(onChain.flatMap((s) => s.txHashes));
    });

    it('fails the step when a transaction fails on-chain, keeping what was submitted', async () => {
        const fake = createFakeApi(buyerKp, sellerKp);
        // 0 = escrow create, 1 = fund, 2..4 = release
        const { ledger } = fakeLedger('50', { 3: { status: 'FAILED', ledger: 777, closedAtUnix: 1_763_000_000 } });
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, null, { ledger }), meta);

        const releaseStep = report.steps.find((s) => s.name === 'escrow_release')!;
        expect(releaseStep.status).toBe('failed');
        expect(releaseStep.error).toMatch(/failed on-chain \(ledger 777\)/);
        expect(releaseStep.txHashes).toHaveLength(2);
        expect(releaseStep.confirmations.map((c) => c.status)).toEqual(['SUCCESS', 'FAILED']);
        expect(report.steps.find((s) => s.name === 'payout_transfer')!.status).toBe('skipped');
    });

    it('fails the step when a transaction never shows up before the confirmation timeout', async () => {
        const fake = createFakeApi(buyerKp, sellerKp);
        const { ledger } = fakeLedger('50', { 1: { status: 'NOT_FOUND' } });
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, null, { ledger }), meta);

        const fund = report.steps.find((s) => s.name === 'escrow_fund')!;
        expect(fund.status).toBe('failed');
        expect(fund.error).toMatch(/not found on-chain within 30000ms/);
        expect(fund.confirmations[0]).toMatchObject({ status: 'NOT_FOUND', confirmedInMs: 30_000 });
    });

    it('keeps polling through transient RPC errors', async () => {
        const fake = createFakeApi(buyerKp, sellerKp);
        let failures = 2;
        const base = fakeLedger('50').ledger;
        const ledger: LedgerReader = {
            usdcBalance: base.usdcBalance,
            getTransaction: async (hash) => {
                if (failures-- > 0) throw new Error('RPC 503');
                return base.getTransaction(hash);
            },
        };
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, null, { ledger }), meta);
        expect(report.status).toBe('passed');
    });

    it('fails when the API reports a different transaction than the one the wallet signed', async () => {
        const fake = createFakeApi(buyerKp, sellerKp, { lieAboutHash: true });
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, '50'), meta);

        const create = report.steps.find((s) => s.name === 'escrow_create')!;
        expect(create.status).toBe('failed');
        expect(create.error).toMatch(/API reported transaction f{64} but the signed transaction is [0-9a-f]{64}/);
    });
});

describe('BlindPay disbursement verification (#317)', () => {
    it('reads the payout from BlindPay itself and attaches the receipt to the report', async () => {
        const fake = createFakeApi(buyerKp, sellerKp);
        const bp = fakeBlindPay();
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(fake.api, '50', { blindpay: bp.reader }), meta);

        expect(report.status).toBe('passed');
        expect(bp.calls).toEqual(['po_1']);
        expect(report.receipt).toMatchObject({
            corridor: 'MX',
            source: 'blindpay',
            blindpayPayoutId: 'po_1',
            status: 'completed',
            currency: 'MXN',
            receiverAmountMinor: 9000,
            paymentProvider: 'SPEI',
            providerTransactionId: 'SPEI123',
            completedAt: '2026-11-10T10:05:00Z',
            matchesPayoutTransfer: null,
        });
        expect(report.steps.at(-1)!.details).toEqual({ receipt: report.receipt });
    });

    it('ties the receipt to the seller transfer the runner signed', async () => {
        const fake = createFakeApi(buyerKp, sellerKp);
        let signedHash = '';
        const ctx = context(fake.api, '50');
        ctx.blindpay = fakeBlindPay(() => {
            signedHash = ctx.payoutTxHash!;
            return blindpayPayout({ tracking_transaction: { status: 'completed', transaction_hash: signedHash.toUpperCase(), completed_at: null } });
        }).reader;
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, ctx, meta);

        expect(signedHash).toBe(report.steps.find((s) => s.name === 'payout_transfer')!.txHashes[0]);
        expect(report.receipt!.matchesPayoutTransfer).toBe(true);
    });

    it('waits while BlindPay is still processing, then verifies', async () => {
        const bp = fakeBlindPay({ status: 'processing' }, { status: 'processing' }, {});
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(createFakeApi(buyerKp, sellerKp).api, '50', { blindpay: bp.reader }), meta);
        expect(report.status).toBe('passed');
        expect(bp.calls).toHaveLength(3);
    });

    it('fails when BlindPay contradicts the OfferHub API', async () => {
        const bp = fakeBlindPay({ status: 'refunded' });
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(createFakeApi(buyerKp, sellerKp).api, '50', { blindpay: bp.reader }), meta);
        const step = report.steps.at(-1)!;
        expect(report.status).toBe('failed');
        expect(step).toMatchObject({ name: 'disbursement_verification', status: 'failed' });
        expect(step.error).toMatch(/refunded, not completed/);
        expect(report.receipt).toBeUndefined();
    });

    it('fails when the fiat went out in another corridor’s currency', async () => {
        const bp = fakeBlindPay({ currency: 'BRL' });
        const report = await runScenario(ESCROW_TO_FIAT_SCENARIO, context(createFakeApi(buyerKp, sellerKp).api, '50', { blindpay: bp.reader }), meta);
        expect(report.steps.at(-1)!.error).toMatch(/paid payout po_1 in BRL; corridor MX pays in MXN/);
    });

    it('gives up on a payout BlindPay never completes', async () => {
        const bp = fakeBlindPay({ status: 'processing' });
        const report = await runScenario(
            ESCROW_TO_FIAT_SCENARIO,
            context(createFakeApi(buyerKp, sellerKp).api, '50', { blindpay: bp.reader, payoutTimeoutMs: 30_000 }),
            meta,
        );
        expect(report.steps.at(-1)!.error).toMatch(/still reports payout po_1 as processing/);
    });
});
