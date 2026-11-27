import type { Corridor } from './config';
import type { DisbursementReceipt } from './types';

/**
 * Independent disbursement check against BlindPay (issue #317).
 *
 * The OfferHub API marks a payout COMPLETED when BlindPay's webhook (or the
 * orchestration poll) says so. The runner does not take that on trust: it reads
 * the same payout straight from BlindPay's API with a read-only key and turns
 * what BlindPay reports into the run's disbursement receipt.
 */

/** Fiat currency BlindPay pays out in, per corridor. Mirrors packages/shared blindpay-corridors. */
export const CORRIDOR_CURRENCY: Record<Corridor, string> = {
    BR: 'BRL',
    MX: 'MXN',
    AR: 'ARS',
    CO: 'COP',
};

interface TrackingStep {
    status: string | null;
    transaction_hash: string | null;
    completed_at: string | null;
}

interface TrackingPayment {
    provider_name: string | null;
    provider_transaction_id: string | null;
    provider_status: string | null;
    completed_at: string | null;
}

/** The subset of BlindPay's payout object the runner reads. Amounts are minor units. */
export interface BlindPayPayoutView {
    id: string;
    status: string;
    currency: string;
    sender_amount: number;
    receiver_amount: number;
    tracking_transaction: TrackingStep | null;
    tracking_payment: TrackingPayment | null;
    tracking_complete: TrackingStep | null;
    updated_at: string;
}

export interface DisbursementReader {
    getPayout(blindpayPayoutId: string): Promise<BlindPayPayoutView>;
}

export class BlindPayReadError extends Error {}

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
}>;

export class HttpBlindPayReader implements DisbursementReader {
    constructor(
        private readonly baseUrl: string,
        private readonly instanceId: string,
        private readonly apiKey: string,
        private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    ) {}

    async getPayout(blindpayPayoutId: string): Promise<BlindPayPayoutView> {
        const url = `${this.baseUrl}/instances/${encodeURIComponent(this.instanceId)}/payouts/${encodeURIComponent(blindpayPayoutId)}`;
        const res = await this.fetchImpl(url, {
            headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        });
        // The key never goes into an error message
        if (!res.ok) throw new BlindPayReadError(`BlindPay returned HTTP ${res.status} for payout ${blindpayPayoutId}`);
        return (await res.json()) as BlindPayPayoutView;
    }
}

/** Payout states BlindPay can still move to `completed` from. */
export const BLINDPAY_PENDING = ['processing'];

export interface ExpectedDisbursement {
    corridor: Corridor;
    /** Hash of the seller's USDC transfer the runner signed and confirmed on-chain */
    payoutTxHash?: string;
    verifiedAt: string;
}

/**
 * Checks a `completed` BlindPay payout against what the run expects and builds
 * its receipt. Throws when BlindPay's record contradicts the run.
 */
export function buildReceipt(view: BlindPayPayoutView, expected: ExpectedDisbursement): DisbursementReceipt {
    if (view.status !== 'completed') {
        throw new Error(`BlindPay reports payout ${view.id} as ${view.status}, not completed`);
    }
    const currency = CORRIDOR_CURRENCY[expected.corridor];
    if (view.currency !== currency) {
        throw new Error(`BlindPay paid payout ${view.id} in ${view.currency}; corridor ${expected.corridor} pays in ${currency}`);
    }
    if (!(view.receiver_amount > 0)) {
        throw new Error(`BlindPay payout ${view.id} has no receiver amount`);
    }

    const stellarTxHash = view.tracking_transaction?.transaction_hash ?? null;
    return {
        corridor: expected.corridor,
        source: 'blindpay',
        blindpayPayoutId: view.id,
        status: 'completed',
        currency: view.currency,
        receiverAmountMinor: view.receiver_amount,
        senderAmountMinor: view.sender_amount,
        stellarTxHash,
        matchesPayoutTransfer:
            stellarTxHash && expected.payoutTxHash ? stellarTxHash.toLowerCase() === expected.payoutTxHash : null,
        paymentProvider: view.tracking_payment?.provider_name ?? null,
        providerTransactionId: view.tracking_payment?.provider_transaction_id ?? null,
        completedAt: view.tracking_complete?.completed_at ?? view.tracking_payment?.completed_at ?? view.updated_at,
        verifiedAt: expected.verifiedAt,
    };
}
