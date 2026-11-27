import { BaseResource } from './base';
import type {
    RegisterRequest,
    RegisteredUser,
    LoginRequest,
    Session,
    WalletChallengeResponse,
    WalletVerifyRequest,
    CreateApiKeyRequest,
    CreatedApiKey,
    ApiKeyInfo,
    CursorPage,
    CursorParams,
} from '../types';

/**
 * Sign-in and API key management.
 *
 * `register`, `login`, `walletChallenge` and `walletVerify` are public.
 * `login` and `walletVerify` return a user session; pass `session.token`
 * to `sdk.asUser()`.
 */
export class AuthResource extends BaseResource {
    /** Email/password sign-up. Sign in with `login` afterwards to get a session. */
    async register(data: RegisterRequest): Promise<RegisteredUser> {
        return this.http.request<RegisteredUser>('POST', 'auth/register', { body: data, authorization: null });
    }

    /** Email/password sign-in. */
    async login(data: LoginRequest): Promise<Session> {
        return this.http.request<Session>('POST', 'auth/login', { body: data, authorization: null });
    }

    /**
     * Step 1 of wallet sign-in: get a nonce for the wallet to sign.
     *
     * @example
     * ```typescript
     * const { challenge } = await sdk.auth.walletChallenge(publicKey);
     * const { signedMessage } = await kit.signMessage(challenge, { address: publicKey });
     * const session = await sdk.auth.walletVerify({ publicKey, challenge, signature: signedMessage });
     * const user = sdk.asUser(session.token);
     * ```
     */
    async walletChallenge(publicKey: string): Promise<WalletChallengeResponse> {
        return this.http.request<WalletChallengeResponse>('POST', 'auth/wallet/challenge', {
            body: { publicKey },
            authorization: null,
        });
    }

    /** Step 2 of wallet sign-in: verify the signature and get a session. */
    async walletVerify(data: WalletVerifyRequest): Promise<Session> {
        return this.http.request<Session>('POST', 'auth/wallet/verify', { body: data, authorization: null });
    }

    /** Creates an API key. Needs the master key or a key with `write` scope. */
    async createApiKey(data: CreateApiKeyRequest): Promise<CreatedApiKey> {
        return this.http.request<CreatedApiKey>('POST', 'auth/api-keys', { body: data });
    }

    /** Lists API keys. Key values are never returned. */
    async listApiKeys(params: CursorParams = {}): Promise<CursorPage<ApiKeyInfo>> {
        return this.http.request<CursorPage<ApiKeyInfo>>('GET', 'auth/api-keys', { query: { ...params } });
    }
}
