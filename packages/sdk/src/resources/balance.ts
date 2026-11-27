import { BaseResource } from './base';
import type { Balance, BalanceOperationRequest } from '../types';

/**
 * Internal balance ledger. Requires an API key.
 *
 * Most integrations only read it: deposits, escrow and releases already move
 * the balance. The write operations are for reconciling your own ledger.
 */
export class BalanceResource extends BaseResource {
    async get(userId: string): Promise<Balance> {
        return this.http.request<Balance>('GET', `users/${userId}/balance`);
    }

    /** Re-reads the user's on-chain USDC balance into the ledger. */
    async sync(userId: string): Promise<Balance> {
        return this.http.request<Balance>('POST', `users/${userId}/balance/sync`);
    }

    async credit(userId: string, data: BalanceOperationRequest): Promise<Balance> {
        return this.http.request<Balance>('POST', `users/${userId}/balance/credit`, { body: data });
    }

    async debit(userId: string, data: BalanceOperationRequest): Promise<Balance> {
        return this.http.request<Balance>('POST', `users/${userId}/balance/debit`, { body: data });
    }

    async reserve(userId: string, data: BalanceOperationRequest): Promise<Balance> {
        return this.http.request<Balance>('POST', `users/${userId}/balance/reserve`, { body: data });
    }

    async release(userId: string, data: BalanceOperationRequest): Promise<Balance> {
        return this.http.request<Balance>('POST', `users/${userId}/balance/release`, { body: data });
    }

    async cancelReservation(userId: string, data: BalanceOperationRequest): Promise<Balance> {
        return this.http.request<Balance>('POST', `users/${userId}/balance/cancel-reservation`, { body: data });
    }

    async deductReserved(userId: string, data: BalanceOperationRequest): Promise<Balance> {
        return this.http.request<Balance>('POST', `users/${userId}/balance/deduct-reserved`, { body: data });
    }
}
