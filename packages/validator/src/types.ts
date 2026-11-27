/**
 * Shared contract of the validation framework (issue #315).
 *
 * #316 (on-chain confirmation), #317 (BlindPay disbursement verification) and
 * #318 (results publication) build on these shapes; change them together.
 */

export type StepStatus = 'passed' | 'failed' | 'skipped';

/** Independent Stellar RPC confirmation of one submitted transaction (#316). */
export interface TxConfirmation {
    hash: string;
    status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
    ledger?: number;
    ledgerClosedAt?: string;
    /** From the API returning the submit call to RPC reporting the transaction in a closed ledger */
    confirmedInMs: number;
    polls: number;
}

/**
 * Proof that a run's fiat disbursement completed, read straight from BlindPay's
 * API (#317), not from the OfferHub API. Amounts are BlindPay minor units.
 */
export interface DisbursementReceipt {
    corridor: string;
    source: 'blindpay';
    blindpayPayoutId: string;
    status: 'completed';
    currency: string;
    receiverAmountMinor: number;
    senderAmountMinor: number;
    /** Stellar transaction BlindPay recorded as the USDC it received */
    stellarTxHash: string | null;
    /** Whether that hash is the seller transfer the runner signed; null when either side is unknown */
    matchesPayoutTransfer: boolean | null;
    /** Local rail that paid the bank account (SPEI, PIX…) and its reference */
    paymentProvider: string | null;
    providerTransactionId: string | null;
    completedAt: string;
    verifiedAt: string;
}

export interface StepResult {
    name: string;
    status: StepStatus;
    /** Stellar transactions this step submitted, in order */
    txHashes: string[];
    /** RPC confirmation of each entry in txHashes, same order */
    confirmations: TxConfirmation[];
    payoutId?: string;
    durationMs: number;
    error?: string;
    /** Extra, non-secret facts worth publishing (order id, contract id, payout status…) */
    details?: Record<string, unknown>;
}

/** What a step hands back on success; the runner adds name, status and timing. */
export interface StepOutcome {
    txHashes?: string[];
    confirmations?: TxConfirmation[];
    payoutId?: string;
    details?: Record<string, unknown>;
}

/** A step failure that still carries what the step did before failing (e.g. submitted transactions). */
export class StepFailure extends Error {
    constructor(
        message: string,
        readonly partial: StepOutcome,
    ) {
        super(message);
    }
}

export interface ValidationStep<Ctx> {
    name: string;
    run(ctx: Ctx): Promise<StepOutcome>;
}

export type RunStatus = 'passed' | 'failed';

export interface RunReport {
    id: string;
    network: 'testnet' | 'mainnet';
    apiUrl: string;
    corridor: string;
    trigger: 'manual' | 'schedule';
    status: RunStatus;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    orderId?: string;
    contractId?: string;
    /** Present only when the disbursement was verified with BlindPay */
    receipt?: DisbursementReceipt;
    steps: StepResult[];
}

/** Destination for finished run reports (console, file; #318 adds the public API). */
export interface Reporter {
    publish(report: RunReport): Promise<void>;
}
