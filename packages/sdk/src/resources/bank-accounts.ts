import { BaseResource } from './base';
import type { BankAccount, CreateBankAccountRequest } from '../types';

/**
 * The signed-in seller's bank accounts for BlindPay payouts. Requires a user
 * session. The default account of the seller's country receives the payout.
 */
export class BankAccountsResource extends BaseResource {
    async list(): Promise<BankAccount[]> {
        return this.http.request<BankAccount[]>('GET', 'users/me/bank-accounts');
    }

    /**
     * Each rail needs its own `details` keys, checked here rather than at
     * payout time — see the Payouts Guide for the list.
     *
     * @example
     * ```typescript
     * await seller.bankAccounts.create({
     *   country: 'MX', rail: 'SPEI_BITSO', accountNumber: '012180001234567891',
     *   bankName: 'BBVA México', holderName: 'Luis Pérez', isDefault: true,
     *   details: { spei_protocol: 'clabe' },
     * });
     * ```
     */
    async create(data: CreateBankAccountRequest): Promise<BankAccount> {
        return this.http.request<BankAccount>('POST', 'users/me/bank-accounts', { body: data });
    }

    async setDefault(bankAccountId: string): Promise<BankAccount> {
        return this.http.request<BankAccount>('PATCH', `users/me/bank-accounts/${bankAccountId}/default`);
    }

    async remove(bankAccountId: string): Promise<void> {
        await this.http.request<unknown>('DELETE', `users/me/bank-accounts/${bankAccountId}`);
    }
}
