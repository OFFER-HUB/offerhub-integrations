import { BaseResource } from './base';
import { newIdempotencyKey } from '../client/http-client';
import type {
    CreateOrderRequest,
    Order,
    ListOrdersParams,
    CursorPage,
    Milestone,
    Payout,
    IdempotentOptions,
} from '../types';

/**
 * Order lifecycle. Requires a user session (`sdk.asUser(token)`).
 *
 * Flow: `create` → `reserve` → escrow (see `escrow`) → work → `resolution`.
 */
export class OrdersResource extends BaseResource {
    /**
     * Creates an order. The buyer needs a connected wallet.
     *
     * @example
     * ```typescript
     * const order = await user.orders.create({
     *   buyer_id: 'usr_buyer', seller_id: 'usr_seller', amount: '100.00', title: 'Landing page',
     *   milestones: [
     *     { milestone_ref: 'design', title: 'Design', amount: '30.00' },
     *     { milestone_ref: 'build', title: 'Build', amount: '70.00' },
     *   ],
     * });
     * ```
     */
    async create(data: CreateOrderRequest, options: IdempotentOptions = {}): Promise<Order> {
        return this.http.request<Order>('POST', 'orders', {
            body: data,
            idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
        });
    }

    async list(params: ListOrdersParams = {}): Promise<CursorPage<Order>> {
        return this.http.request<CursorPage<Order>>('GET', 'orders', { query: { ...params } });
    }

    async get(orderId: string): Promise<Order> {
        return this.http.request<Order>('GET', `orders/${orderId}`);
    }

    /** Moves the order amount from the buyer's available to reserved balance. */
    async reserve(orderId: string): Promise<Order> {
        return this.http.request<Order>('POST', `orders/${orderId}/reserve`);
    }

    /** Cancels an order that has no escrow yet; reserved funds go back to available. */
    async cancel(orderId: string, reason?: string): Promise<Order> {
        return this.http.request<Order>('POST', `orders/${orderId}/cancel`, { body: reason ? { reason } : {} });
    }

    async milestones(orderId: string): Promise<Milestone[]> {
        return this.http.request<Milestone[]>('GET', `orders/${orderId}/milestones`);
    }

    /** Seller marks a milestone as delivered. */
    async completeMilestone(orderId: string, milestoneRef: string): Promise<Milestone> {
        return this.http.request<Milestone>('POST', `orders/${orderId}/milestones/${milestoneRef}/complete`);
    }

    /** Seller marks the whole order as delivered. */
    async markDelivered(orderId: string): Promise<Order> {
        return this.http.request<Order>('POST', `orders/${orderId}/complete`);
    }

    /**
     * The order's BlindPay payout. 404s (`NotFoundError`) until the escrow
     * is released.
     */
    async payout(orderId: string): Promise<Payout> {
        return this.http.request<Payout>('GET', `orders/${orderId}/payout`);
    }
}
