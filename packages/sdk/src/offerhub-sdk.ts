import {
    HttpClient,
    ApiKeyCredentials,
    BearerToken,
    Anonymous,
    type Credentials,
    type FetchLike,
} from './client/http-client';
import { AuthResource } from './resources/auth';
import { UsersResource } from './resources/users';
import { BalanceResource } from './resources/balance';
import { WithdrawalsResource } from './resources/withdrawals';
import { OrdersResource } from './resources/orders';
import { EscrowResource } from './resources/escrow';
import { ResolutionResource } from './resources/resolution';
import { DisputesResource } from './resources/disputes';
import { WalletResource } from './resources/wallet';
import { PayoutsResource } from './resources/payouts';
import { BankAccountsResource } from './resources/bank-accounts';
import { KycResource } from './resources/kyc';

/**
 * Configuration options for the OfferHub SDK.
 *
 * Pass `apiKey` on your marketplace backend, or `accessToken` to act as a
 * signed-in user. With neither, only the public `auth` calls work.
 */
export interface OfferHubSDKConfig {
    /** Orchestrator URL, e.g. `https://api.yourapp.com` (`/api/v1` is added for you) */
    apiUrl: string;
    /** Marketplace API key (`ohk_live_...`). Needs `write` scope to mint request tokens. */
    apiKey?: string;
    /** A user's JWT from `auth.login` / `auth.walletVerify` */
    accessToken?: string;
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Retries for GET requests on network errors, 429 and 5xx (default: 2) */
    retryAttempts?: number;
    /** Extra headers sent on every request */
    headers?: Record<string, string>;
    /** Custom `fetch` (defaults to the global one) */
    fetch?: FetchLike;
}

/**
 * OfferHub Orchestrator client.
 *
 * Two kinds of endpoints, two kinds of credentials:
 *
 * | With an API key (your backend) | With a user session |
 * |---|---|
 * | `users`, `balance`, `withdrawals`, `auth` API keys | `orders`, `escrow`, `resolution`, `disputes`, `wallet`, `payouts`, `bankAccounts`, `kyc` |
 *
 * @example
 * ```typescript
 * import { OfferHubSDK } from '@offerhub/sdk';
 *
 * const sdk = new OfferHubSDK({ apiUrl: 'https://api.yourapp.com', apiKey: process.env.OFFERHUB_API_KEY });
 *
 * const session = await sdk.auth.login({ email: 'ana@example.com', password: '...' });
 * const ana = sdk.asUser(session.token);
 *
 * const order = await ana.orders.create({ buyer_id: session.user.id, seller_id: 'usr_seller', amount: '100.00', title: 'Logo' });
 * await ana.orders.reserve(order.id);
 * ```
 */
export class OfferHubSDK {
    /** Sign-in (public) and API key management */
    public readonly auth: AuthResource;

    // API key resources
    public readonly users: UsersResource;
    public readonly balance: BalanceResource;
    public readonly withdrawals: WithdrawalsResource;

    // User session resources
    public readonly orders: OrdersResource;
    public readonly escrow: EscrowResource;
    public readonly resolution: ResolutionResource;
    public readonly disputes: DisputesResource;
    public readonly wallet: WalletResource;
    public readonly payouts: PayoutsResource;
    public readonly bankAccounts: BankAccountsResource;
    public readonly kyc: KycResource;

    private readonly http: HttpClient;

    constructor(private readonly config: OfferHubSDKConfig) {
        this.http = new HttpClient({
            apiUrl: config.apiUrl,
            credentials: OfferHubSDK.credentialsFor(config),
            timeout: config.timeout,
            retryAttempts: config.retryAttempts,
            headers: config.headers,
            fetch: config.fetch,
        });

        this.auth = new AuthResource(this.http);
        this.users = new UsersResource(this.http);
        this.balance = new BalanceResource(this.http);
        this.withdrawals = new WithdrawalsResource(this.http);
        this.orders = new OrdersResource(this.http);
        this.escrow = new EscrowResource(this.http);
        this.resolution = new ResolutionResource(this.http);
        this.disputes = new DisputesResource(this.http);
        this.wallet = new WalletResource(this.http);
        this.payouts = new PayoutsResource(this.http);
        this.bankAccounts = new BankAccountsResource(this.http);
        this.kyc = new KycResource(this.http);
    }

    /**
     * Returns a client that acts as the user behind `accessToken`, with the
     * same URL, timeout and headers.
     */
    asUser(accessToken: string): OfferHubSDK {
        return new OfferHubSDK({ ...this.config, apiKey: undefined, accessToken });
    }

    private static credentialsFor(config: OfferHubSDKConfig): Credentials {
        if (config.accessToken) return new BearerToken(config.accessToken);
        if (config.apiKey) return new ApiKeyCredentials(config.apiKey);
        return new Anonymous();
    }
}
