import {
    OfferHubSDK,
    ApiKeyCredentials,
    ConflictError,
    InsufficientFundsError,
    NotFoundError,
    ValidationError,
    type FetchLike,
} from '../index';

const API_KEY = 'ohk_live_key_abc123XYZ_0123456789abcdef';

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Fake fetch: answers the token exchange itself, everything else from `routes`
 * (matched on "METHOD path", first match wins, each response used once unless
 * it is the last one for that route).
 */
function fakeFetch(routes: Record<string, Array<() => Response>>) {
    const calls: Call[] = [];
    let minted = 0;
    const impl: FetchLike = async (url, init) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        const call: Call = {
            url,
            method: init.method ?? 'GET',
            headers,
            body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        const path = new URL(url).pathname.replace('/api/v1/', '');
        if (call.method === 'POST' && path === 'auth/api-keys/key_abc123XYZ/token') {
            minted++;
            return json(200, { data: { token: `ohk_tok_jwt${minted}` }, meta: {} });
        }
        const queue = routes[`${call.method} ${path}`];
        if (!queue || queue.length === 0) return json(404, { error: { code: 'NOT_ROUTED', message: path } });
        const next = queue.length > 1 ? queue.shift()! : queue[0];
        return next();
    };
    return { impl, calls, minted: () => minted };
}

describe('OfferHubSDK', () => {
    describe('URLs and response envelopes', () => {
        it('appends /api/v1 once and unwraps { data, meta }', async () => {
            const { impl, calls } = fakeFetch({
                'POST users': [() => json(201, { data: { id: 'usr_1', externalUserId: 'ext_1' } })],
            });
            const sdk = new OfferHubSDK({ apiUrl: 'https://api.example.com/', apiKey: API_KEY, fetch: impl });

            const user = await sdk.users.create({ externalUserId: 'ext_1' });

            expect(user).toEqual({ id: 'usr_1', externalUserId: 'ext_1' });
            expect(calls[1].url).toBe('https://api.example.com/api/v1/users');

            const sdk2 = new OfferHubSDK({ apiUrl: 'https://api.example.com/api/v1', apiKey: API_KEY, fetch: impl });
            await sdk2.users.create({ externalUserId: 'ext_1' });
            expect(calls[calls.length - 1].url).toBe('https://api.example.com/api/v1/users');
        });

        it('returns the page object of a double-wrapped cursor list', async () => {
            const page = { data: [{ id: 'wd_1' }], hasMore: true, nextCursor: 'wd_1' };
            const { impl, calls } = fakeFetch({
                'GET withdrawals': [() => json(200, { data: page, meta: { requestId: 'r' } })],
            });
            const sdk = new OfferHubSDK({ apiUrl: 'https://api.example.com', apiKey: API_KEY, fetch: impl });

            const result = await sdk.withdrawals.list({ userId: 'usr_1', limit: 10 });

            expect(result).toEqual(page);
            expect(calls[1].url).toBe('https://api.example.com/api/v1/withdrawals?userId=usr_1&limit=10');
        });

        it('keeps meta when the endpoint paginates through it (wallet transactions)', async () => {
            const body = { data: [{ id: 'tx_1', type: 'credit' }], meta: { limit: 20, count: 1, nextCursor: null } };
            const { impl } = fakeFetch({ 'GET wallet/transactions': [() => json(200, body)] });
            const user = new OfferHubSDK({ apiUrl: 'https://api.example.com', accessToken: 'jwt', fetch: impl });

            await expect(user.wallet.transactions()).resolves.toEqual(body);
        });
    });

    describe('API key credentials', () => {
        it('exchanges the API key for a short-lived token and reuses it', async () => {
            const { impl, calls, minted } = fakeFetch({
                'POST users': [() => json(201, { data: { id: 'usr_1' } })],
            });
            const sdk = new OfferHubSDK({ apiUrl: 'https://api.example.com', apiKey: API_KEY, fetch: impl });

            await sdk.users.create({ externalUserId: 'a' });
            await sdk.users.create({ externalUserId: 'b' });

            expect(minted()).toBe(1);
            expect(calls[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
            expect(calls[1].headers.Authorization).toBe('Bearer ohk_tok_jwt1');
            expect(calls[2].headers.Authorization).toBe('Bearer ohk_tok_jwt1');
        });

        it('mints a fresh token once after a 401', async () => {
            const { impl, calls, minted } = fakeFetch({
                'GET users/usr_1/balance': [
                    () => json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } }),
                    () => json(200, { data: { user_id: 'usr_1', available: '10.00' } }),
                ],
            });
            const sdk = new OfferHubSDK({ apiUrl: 'https://api.example.com', apiKey: API_KEY, fetch: impl });

            const balance = await sdk.balance.get('usr_1');

            expect(balance.available).toBe('10.00');
            expect(minted()).toBe(2);
            expect(calls[calls.length - 1].headers.Authorization).toBe('Bearer ohk_tok_jwt2');
        });

        it('sends a value that is not an API key (master key) as-is', async () => {
            const { impl, calls, minted } = fakeFetch({
                'POST auth/api-keys': [() => json(200, { data: { id: 'key_1', key: 'ohk_live_key_1_x', name: 'k', scopes: ['read'] } })],
            });
            const sdk = new OfferHubSDK({ apiUrl: 'https://api.example.com', apiKey: 'ohk_master_secret', fetch: impl });

            await sdk.auth.createApiKey({ name: 'k', scopes: ['read'] });

            expect(minted()).toBe(0);
            expect(calls[0].headers.Authorization).toBe('Bearer ohk_master_secret');
        });

        it('parses the key id out of an API key', () => {
            expect(ApiKeyCredentials.keyIdOf(API_KEY)).toBe('key_abc123XYZ');
            expect(ApiKeyCredentials.keyIdOf('ohk_master_secret')).toBeNull();
        });
    });

    describe('user sessions', () => {
        it('asUser sends the JWT and never mints an API-key token', async () => {
            const { impl, calls, minted } = fakeFetch({
                'POST auth/login': [() => json(200, { data: { user: { id: 'usr_1' }, token: 'user-jwt' } })],
                'GET orders/ord_1': [() => json(200, { data: { id: 'ord_1' }, meta: {} })],
            });
            const sdk = new OfferHubSDK({ apiUrl: 'https://api.example.com', apiKey: API_KEY, fetch: impl });

            const session = await sdk.auth.login({ email: 'a@b.co', password: 'pw' });
            const user = sdk.asUser(session.token);
            await user.orders.get('ord_1');

            expect(calls[0].headers.Authorization).toBeUndefined();
            expect(calls[1].headers.Authorization).toBe('Bearer user-jwt');
            expect(minted()).toBe(0);
        });
    });

    describe('idempotency', () => {
        it('generates an Idempotency-Key on money-moving calls and honours a given one', async () => {
            const { impl, calls } = fakeFetch({
                'POST orders/ord_1/payout/submit': [() => json(200, { data: { id: 'pay_1', status: 'PROCESSING' } })],
                'POST orders': [() => json(201, { data: { id: 'ord_1' } })],
            });
            const user = new OfferHubSDK({ apiUrl: 'https://api.example.com', accessToken: 'jwt', fetch: impl });

            await user.payouts.submit('ord_1', { signedXdr: 'AAA', quoteId: 'qu_1' });
            await user.orders.create(
                { buyer_id: 'usr_b', seller_id: 'usr_s', amount: '10.00', title: 't' },
                { idempotencyKey: 'mine-123' },
            );

            expect(calls[0].headers['Idempotency-Key']).toMatch(/.{8,}/);
            expect(calls[0].body).toEqual({ signedXdr: 'AAA', quoteId: 'qu_1' });
            expect(calls[1].headers['Idempotency-Key']).toBe('mine-123');
        });

        it('cannot create a withdrawal: the server no longer moves a user\'s funds (3.0.0)', () => {
            const sdk = new OfferHubSDK({ apiUrl: 'https://api.example.com', apiKey: API_KEY, fetch: fakeFetch({}).impl });
            expect('create' in sdk.withdrawals).toBe(false);
            const user = sdk.asUser('jwt');
            expect('release' in user.resolution).toBe(false);
            expect('refund' in user.resolution).toBe(false);
            expect('releaseMilestone' in user.resolution).toBe(false);
            expect('create' in user.escrow).toBe(false);
            expect('fund' in user.escrow).toBe(false);
        });
    });

    describe('errors', () => {
        it('maps { error: { code, message } } to typed errors', async () => {
            const { impl } = fakeFetch({
                'POST orders': [() => json(422, { error: { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient available balance' } })],
                'POST orders/ord_1/payout/retry': [() => json(409, { error: { code: 'INVALID_STATE', message: 'not FAILED' } })],
                'GET orders/ord_2/payout': [() => json(404, { error: { code: 'PAYOUT_NOT_FOUND', message: 'No payout' } })],
                'POST users/me/bank-accounts': [() => json(400, { statusCode: 400, message: ['rail must be a string'] })],
            });
            const sdk = new OfferHubSDK({ apiUrl: 'https://api.example.com', apiKey: API_KEY, fetch: impl });
            const user = sdk.asUser('jwt');

            await expect(
                user.orders.create({ buyer_id: 'usr_b', seller_id: 'usr_s', amount: '10.00', title: 't' }),
            ).rejects.toBeInstanceOf(InsufficientFundsError);

            const conflict = await user.payouts.retry('ord_1').catch((e: unknown) => e);
            expect(conflict).toBeInstanceOf(ConflictError);
            expect((conflict as ConflictError).code).toBe('INVALID_STATE');

            const missing = await user.payouts.get('ord_2').catch((e: unknown) => e);
            expect(missing).toBeInstanceOf(NotFoundError);
            expect((missing as NotFoundError).code).toBe('PAYOUT_NOT_FOUND');

            const invalid = await user.bankAccounts
                .create({ country: 'MX', rail: 'SPEI_BITSO', accountNumber: '1', bankName: 'b', holderName: 'h' })
                .catch((e: unknown) => e);
            expect(invalid).toBeInstanceOf(ValidationError);
            expect((invalid as ValidationError).message).toBe('rail must be a string');
        });

        it('retries GETs on 503 but never retries a POST', async () => {
            const { impl, calls } = fakeFetch({
                'GET users/me/kyc': [
                    () => json(503, { error: { code: 'UNAVAILABLE', message: 'down' } }),
                    () => json(200, { data: { id: 'kyc_1' } }),
                ],
                'POST users/me/kyc/tos-accept': [() => json(503, { error: { code: 'UNAVAILABLE', message: 'down' } })],
            });
            const user = new OfferHubSDK({ apiUrl: 'https://api.example.com', accessToken: 'jwt', fetch: impl });

            await expect(user.kyc.get()).resolves.toEqual({ id: 'kyc_1' });
            await expect(user.kyc.acceptTos('to_1')).rejects.toMatchObject({ statusCode: 503 });

            expect(calls.filter((c) => c.url.endsWith('/users/me/kyc'))).toHaveLength(2);
            expect(calls.filter((c) => c.url.endsWith('/tos-accept'))).toHaveLength(1);
        });
    });

    describe('resolution', () => {
        it('adds the orderId to the dispute body the API validates', async () => {
            const { impl, calls } = fakeFetch({
                'POST orders/ord_1/resolution/dispute': [() => json(201, { data: { id: 'dsp_1' } })],
            });
            const user = new OfferHubSDK({ apiUrl: 'https://api.example.com', accessToken: 'jwt', fetch: impl });

            await user.resolution.openDispute('ord_1', { openedBy: 'BUYER', reason: 'NOT_DELIVERED' });

            expect(calls[0].body).toEqual({ openedBy: 'BUYER', reason: 'NOT_DELIVERED', orderId: 'ord_1' });
        });
    });
});
