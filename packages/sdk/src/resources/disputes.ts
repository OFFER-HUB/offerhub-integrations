import { BaseResource } from './base';
import type { Dispute, DisputePage, ListDisputesParams, ResolveDisputeRequest } from '../types';

/**
 * Disputes. Requires a user session. Non-admins only see disputes on their
 * own orders; `assign` and `resolve` need an admin.
 */
export class DisputesResource extends BaseResource {
    async list(params: ListDisputesParams = {}): Promise<DisputePage> {
        return this.http.request<DisputePage>('GET', 'disputes', { query: { ...params } });
    }

    async get(disputeId: string): Promise<Dispute> {
        return this.http.request<Dispute>('GET', `disputes/${disputeId}`);
    }

    /** Admin: assign the dispute to a support agent. */
    async assign(disputeId: string, assignedTo: string): Promise<Dispute> {
        return this.http.request<Dispute>('POST', `disputes/${disputeId}/assign`, { body: { assignedTo } });
    }

    /**
     * Admin: resolve. `SPLIT` needs `releaseAmount` (seller) and
     * `refundAmount` (buyer) adding up to the escrow amount; the seller's
     * share is then paid out through BlindPay.
     */
    async resolve(disputeId: string, data: ResolveDisputeRequest): Promise<Dispute> {
        return this.http.request<Dispute>('POST', `disputes/${disputeId}/resolve`, { body: data });
    }

    /** The user who opened the dispute withdraws it. */
    async cancel(disputeId: string): Promise<Dispute> {
        return this.http.request<Dispute>('POST', `disputes/${disputeId}/cancel`);
    }
}
