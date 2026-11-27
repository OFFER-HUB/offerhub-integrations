import { BaseResource } from './base';
import { newIdempotencyKey } from '../client/http-client';
import type {
    Payout,
    PreparedPayoutTransfer,
    SubmitPayoutTransferRequest,
    IdempotentOptions,
} from '../types';

/**
 * BlindPay payouts: a seller's released USDC, paid into their bank account
 * in BRL, MXN, ARS or COP. Requires a user session.
 *
 * A payout starts on its own when the escrow is released. Custodial sellers
 * need to do nothing. A seller with their own wallet sees the payout in
 * `AWAITING_SIGNATURE` and signs the USDC transfer with `prepare` + `submit`.
 *
 * @example
 * ```typescript
 * const payout = await seller.payouts.get(orderId);
 * if (payout.status === 'AWAITING_SIGNATURE') {
 *   const transfer = await seller.payouts.prepare(orderId);
 *   const { signedTxXdr } = await kit.signTransaction(transfer.unsignedXdr, { networkPassphrase });
 *   await seller.payouts.submit(orderId, { signedXdr: signedTxXdr, quoteId: transfer.quoteId });
 * }
 * ```
 */
export class PayoutsResource extends BaseResource {
    /** Buyer or seller of the order. `NotFoundError` until the escrow is released. */
    async get(orderId: string): Promise<Payout> {
        return this.http.request<Payout>('GET', `orders/${orderId}/payout`);
    }

    /**
     * Seller: the unsigned transfer to BlindPay. Safe to call again — an
     * unexpired quote is returned as-is.
     */
    async prepare(orderId: string): Promise<PreparedPayoutTransfer> {
        return this.http.request<PreparedPayoutTransfer>('POST', `orders/${orderId}/payout/prepare`);
    }

    /**
     * Seller: dispatch the signed transfer. Rejected (`ConflictError`) if a
     * newer `prepare` replaced the quote — prepare and sign again.
     */
    async submit(orderId: string, data: SubmitPayoutTransferRequest, options: IdempotentOptions = {}): Promise<Payout> {
        return this.http.request<Payout>('POST', `orders/${orderId}/payout/submit`, {
            body: data,
            idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
        });
    }

    /**
     * Seller: retry a `FAILED` payout against their current default bank
     * account for the corridor.
     */
    async retry(orderId: string): Promise<Payout> {
        return this.http.request<Payout>('POST', `orders/${orderId}/payout/retry`);
    }
}
