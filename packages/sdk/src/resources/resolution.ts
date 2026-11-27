import { BaseResource } from './base';
import type {
    Dispute,
    OpenDisputeRequest,
    PreparedEscrowStep,
} from '../types';

/**
 * Releasing, refunding and disputing a funded escrow. Requires a user session.
 *
 * Release, refund and dispute take several transactions signed by different
 * parties, each from their own wallet (the server never signs for a user since
 * 3.0.0). Loop: `prepare*` returns the next step and
 * who signs it, that party signs, `escrow.submit(orderId, operation, xdr)`,
 * repeat until `unsignedXdr` is null. Calling `prepare*` again is safe —
 * steps that already landed are skipped.
 *
 * @example
 * ```typescript
 * let step = await buyer.resolution.prepareRelease(orderId);
 * while (step.unsignedXdr) {
 *   const signer = step.signer === 'buyer' ? buyer : seller;
 *   const signed = await signWith(step.signer, step.unsignedXdr);
 *   await signer.escrow.submit(orderId, 'release', signed);
 *   step = await signer.resolution.prepareRelease(orderId);
 * }
 * ```
 */
export class ResolutionResource extends BaseResource {
    async prepareRelease(orderId: string): Promise<PreparedEscrowStep> {
        return this.http.request<PreparedEscrowStep>('POST', `orders/${orderId}/resolution/release/prepare`);
    }

    async prepareRefund(orderId: string): Promise<PreparedEscrowStep> {
        return this.http.request<PreparedEscrowStep>('POST', `orders/${orderId}/resolution/refund/prepare`);
    }

    async prepareDispute(orderId: string): Promise<PreparedEscrowStep> {
        return this.http.request<PreparedEscrowStep>('POST', `orders/${orderId}/resolution/dispute/prepare`);
    }

    /**
     * Records a dispute, which freezes the escrow until an admin resolves it.
     * Sign the on-chain dispute first (`prepareDispute` + `escrow.submit`):
     * the admin's resolution is signed by the platform alone and needs the
     * escrow already disputed on-chain.
     */
    async openDispute(orderId: string, data: OpenDisputeRequest): Promise<Dispute> {
        return this.http.request<Dispute>('POST', `orders/${orderId}/resolution/dispute`, {
            body: { ...data, orderId },
        });
    }
}
