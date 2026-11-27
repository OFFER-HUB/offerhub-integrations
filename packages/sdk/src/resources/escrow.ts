import { BaseResource } from './base';
import { newIdempotencyKey } from '../client/http-client';
import type {
    PreparedEscrowTransaction,
    EscrowSubmitOperation,
    SubmittedEscrowTransaction,
    IdempotentOptions,
} from '../types';

/**
 * Soroban escrow for an order. Requires a user session.
 *
 * Users sign client-side with their own wallet (Freighter, Lobstr, xBull):
 * `prepareCreate`/`prepareFund` return an unsigned XDR, the wallet signs it,
 * and `submit` sends it. The server never signs for a user (3.0.0).
 *
 * @example
 * ```typescript
 * const { unsignedXdr } = await user.escrow.prepareCreate(orderId);
 * const { signedTxXdr } = await kit.signTransaction(unsignedXdr, { networkPassphrase });
 * await user.escrow.submit(orderId, 'create', signedTxXdr);
 * ```
 */
export class EscrowResource extends BaseResource {
    async prepareCreate(orderId: string): Promise<PreparedEscrowTransaction> {
        return this.http.request<PreparedEscrowTransaction>('POST', `orders/${orderId}/escrow/prepare`);
    }

    async prepareFund(orderId: string): Promise<PreparedEscrowTransaction> {
        return this.http.request<PreparedEscrowTransaction>('POST', `orders/${orderId}/escrow/fund/prepare`);
    }

    /**
     * Submits a wallet-signed XDR. `operation` is the flow it belongs to:
     * `create` or `fund` from this resource, or `release`/`refund`/`dispute`
     * from the `resolution` prepare calls.
     */
    async submit(
        orderId: string,
        operation: EscrowSubmitOperation,
        signedXdr: string,
        options: IdempotentOptions = {},
    ): Promise<SubmittedEscrowTransaction> {
        return this.http.request<SubmittedEscrowTransaction>('POST', `orders/${orderId}/escrow/submit`, {
            body: { operation, signedXdr },
            idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
        });
    }
}
