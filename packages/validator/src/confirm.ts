import { TransactionBuilder } from '@stellar/stellar-sdk';
import type { LedgerReader, TxLookup } from './ledger';
import type { TxConfirmation } from './types';

/**
 * Independent on-chain confirmation (issue #316).
 *
 * After every transaction the runner submits through the API, it asks Stellar
 * RPC itself whether that transaction landed, instead of trusting the API's
 * response. A transaction that fails on-chain, or isn't found before the
 * timeout, fails the validation step.
 */

export interface ConfirmOptions {
    timeoutMs: number;
    pollIntervalMs: number;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
}

export class ConfirmationError extends Error {
    constructor(
        message: string,
        readonly confirmation: TxConfirmation,
    ) {
        super(message);
    }
}

/** Hash of a signed transaction, computed locally: what the network will call it. */
export function transactionHash(signedXdr: string, networkPassphrase: string): string {
    return TransactionBuilder.fromXDR(signedXdr, networkPassphrase).hash().toString('hex');
}

/**
 * Polls Stellar RPC until `hash` is in a closed ledger.
 * `confirmedInMs` is measured from the moment this is called, i.e. right after
 * the API returned from the submit call.
 */
export async function confirmTransaction(
    ledger: LedgerReader,
    hash: string,
    opts: ConfirmOptions,
): Promise<TxConfirmation> {
    const startedAt = opts.now();
    const deadline = startedAt + opts.timeoutMs;
    let polls = 0;

    for (;;) {
        polls++;
        let lookup: TxLookup;
        try {
            lookup = await ledger.getTransaction(hash);
        } catch {
            // A transient RPC error is not a verdict on the transaction; keep polling until the deadline
            lookup = { status: 'NOT_FOUND' };
        }

        if (lookup.status === 'SUCCESS' || lookup.status === 'FAILED') {
            const confirmation: TxConfirmation = {
                hash,
                status: lookup.status,
                ledger: lookup.ledger,
                ledgerClosedAt: new Date(lookup.closedAtUnix * 1000).toISOString(),
                confirmedInMs: opts.now() - startedAt,
                polls,
            };
            if (lookup.status === 'FAILED') {
                throw new ConfirmationError(
                    `Transaction ${hash} failed on-chain (ledger ${lookup.ledger})`,
                    confirmation,
                );
            }
            return confirmation;
        }

        if (opts.now() >= deadline) {
            throw new ConfirmationError(`Transaction ${hash} was not found on-chain within ${opts.timeoutMs}ms`, {
                hash,
                status: 'NOT_FOUND',
                confirmedInMs: opts.now() - startedAt,
                polls,
            });
        }
        await opts.sleep(opts.pollIntervalMs);
    }
}
