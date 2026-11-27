import { BaseResource } from './base';
import type {
    Wallet,
    WalletSummary,
    WalletTransactionsPage,
    WalletTransactionsParams,
    ConnectWalletRequest,
    ClaimWalletRequest,
    WalletClaimResult,
} from '../types';

/**
 * The signed-in user's wallets. Requires a user session.
 *
 * `connect` and `claim` need a signature over a challenge from
 * `sdk.auth.walletChallenge(publicKey)`.
 */
export class WalletResource extends BaseResource {
    /** Balances and this month's earnings/spending. */
    async summary(): Promise<WalletSummary> {
        return this.http.request<WalletSummary>('GET', 'wallet');
    }

    /** Every wallet the user has connected, active or not. */
    async list(): Promise<Wallet[]> {
        return this.http.request<Wallet[]>('GET', 'wallet/wallets');
    }

    async transactions(params: WalletTransactionsParams = {}): Promise<WalletTransactionsPage> {
        return this.http.request<WalletTransactionsPage>('GET', 'wallet/transactions', {
            query: { ...params },
            envelope: true,
        });
    }

    /** Links the user's own Stellar wallet (Freighter, Lobstr, xBull) to the account. */
    async connect(data: ConnectWalletRequest): Promise<Wallet[]> {
        return this.http.request<Wallet[]>('POST', 'wallet/connect', { body: data });
    }

    /**
     * "Claim your wallet": makes the user's own key the signer of their
     * custodial account, without moving funds. Refused while an escrow is
     * still active.
     */
    async claim(data: ClaimWalletRequest): Promise<WalletClaimResult> {
        return this.http.request<WalletClaimResult>('POST', 'wallet/claim', { body: data });
    }

    async disconnect(walletId: string): Promise<Wallet[]> {
        return this.http.request<Wallet[]>('POST', 'wallet/disconnect', { body: { walletId } });
    }

    async reconnect(walletId: string): Promise<Wallet[]> {
        return this.http.request<Wallet[]>('POST', 'wallet/reconnect', { body: { walletId } });
    }

    async setPrimary(walletId: string): Promise<Wallet[]> {
        return this.http.request<Wallet[]>('POST', 'wallet/set-primary', { body: { walletId } });
    }
}
