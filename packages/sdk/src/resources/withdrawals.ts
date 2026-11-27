import { BaseResource } from './base';
import type {
    Withdrawal,
    ListWithdrawalsParams,
    CursorPage,
} from '../types';

/**
 * Withdrawal history. Requires an API key.
 *
 * Creating a withdrawal is no longer possible with an API key: it meant the
 * server signing a USDC payment from the user's custodial wallet, which
 * OfferHub no longer does (3.0.0). Users move their own funds from their own
 * wallet. Paying a seller into their bank account happens through BlindPay
 * when the escrow is released — see `payouts`.
 */
export class WithdrawalsResource extends BaseResource {
    async list(params: ListWithdrawalsParams): Promise<CursorPage<Withdrawal>> {
        return this.http.request<CursorPage<Withdrawal>>('GET', 'withdrawals', { query: { ...params } });
    }

    async get(withdrawalId: string, userId: string): Promise<Withdrawal> {
        return this.http.request<Withdrawal>('GET', `withdrawals/${withdrawalId}`, { query: { userId } });
    }
}
