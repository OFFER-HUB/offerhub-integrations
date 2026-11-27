import { parseError, NetworkError, OfferHubError } from '../errors';

export const SDK_VERSION = '2.0.0';

/** Minimal `fetch` signature, so tests and non-Node runtimes can inject their own. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Something that can produce an `Authorization` header value.
 */
export interface Credentials {
    authorization(http: HttpClient): Promise<string | null>;
    /** Drop any cached token so the next request mints a fresh one. */
    invalidate?(): void;
}

/** A token that is used as-is: a user JWT, or an `ohk_tok_` token you minted yourself. */
export class BearerToken implements Credentials {
    constructor(private readonly token: string) {}

    async authorization(): Promise<string> {
        return `Bearer ${this.token}`;
    }
}

/** No credentials — for the public auth endpoints. */
export class Anonymous implements Credentials {
    async authorization(): Promise<null> {
        return null;
    }
}

// Tokens minted from an API key live 1h; refresh a little before that.
const API_KEY_TOKEN_TTL_MS = 55 * 60 * 1000;

/**
 * A marketplace API key (`ohk_{env}_key_{id}_{secret}`).
 *
 * The API's global JWT guard rejects a raw API key on every business
 * endpoint, so the key is exchanged for a short-lived `ohk_tok_` token
 * (`POST /auth/api-keys/:id/token`) and that token is what gets sent. It is
 * cached and re-minted before it expires, or right away after a 401.
 *
 * A value that isn't shaped like an API key (the bootstrap master key) is
 * sent as-is — it only works on the `/auth/api-keys` endpoints.
 */
export class ApiKeyCredentials implements Credentials {
    private cached: { token: string; expiresAt: number } | null = null;
    private inFlight: Promise<string> | null = null;
    private readonly keyId: string | null;

    constructor(private readonly apiKey: string, private readonly now: () => number = Date.now) {
        this.keyId = ApiKeyCredentials.keyIdOf(apiKey);
    }

    /** `ohk_live_key_abc_secret` → `key_abc`; null for anything else. */
    static keyIdOf(apiKey: string): string | null {
        const parts = apiKey.split('_');
        if (parts.length < 5 || parts[0] !== 'ohk' || parts[2] !== 'key') return null;
        return `${parts[2]}_${parts[3]}`;
    }

    async authorization(http: HttpClient): Promise<string> {
        if (!this.keyId) return `Bearer ${this.apiKey}`;
        if (this.cached && this.cached.expiresAt > this.now()) {
            return `Bearer ${this.cached.token}`;
        }
        if (!this.inFlight) {
            this.inFlight = http
                .send<{ token: string }>('POST', `auth/api-keys/${this.keyId}/token`, {
                    authorization: `Bearer ${this.apiKey}`,
                })
                .then(({ token }) => {
                    this.cached = { token, expiresAt: this.now() + API_KEY_TOKEN_TTL_MS };
                    return token;
                })
                .finally(() => {
                    this.inFlight = null;
                });
        }
        return `Bearer ${await this.inFlight}`;
    }

    invalidate(): void {
        this.cached = null;
    }
}

export interface HttpClientConfig {
    /** Orchestrator URL, e.g. `https://api.yourapp.com`. `/api/v1` is appended when missing. */
    apiUrl: string;
    credentials: Credentials;
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Retries for GET requests on network errors, 429 and 5xx (default: 2) */
    retryAttempts?: number;
    /** Extra headers sent on every request */
    headers?: Record<string, string>;
    /** Defaults to the global `fetch` */
    fetch?: FetchLike;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    /** Sets `Idempotency-Key` */
    idempotencyKey?: string;
    /** Overrides the client's credentials for this one request */
    authorization?: string | null;
    /** Return the whole `{ data, meta }` body instead of just `data` */
    envelope?: boolean;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Generates an idempotency key, using the platform's UUID when available. */
export function newIdempotencyKey(): string {
    const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    return `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Thin `fetch` wrapper: auth, timeouts, GET retries, typed errors, and
 * unwrapping of the API's `{ data, meta }` envelope.
 */
export class HttpClient {
    private readonly baseUrl: string;
    private readonly fetchImpl: FetchLike;

    constructor(private readonly config: HttpClientConfig) {
        const trimmed = config.apiUrl.replace(/\/+$/, '');
        this.baseUrl = trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
        const fetchImpl = config.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
        if (!fetchImpl) {
            throw new Error('No fetch implementation available — pass `fetch` in the SDK config (Node 18+ has one built in).');
        }
        this.fetchImpl = fetchImpl;
    }

    /** Same settings, different credentials. */
    withCredentials(credentials: Credentials): HttpClient {
        return new HttpClient({ ...this.config, credentials });
    }

    /**
     * Sends a request and returns the unwrapped `data` of the response.
     */
    async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
        const usesClientCredentials = options.authorization === undefined;
        try {
            return await this.send<T>(method, path, options);
        } catch (error) {
            // A cached API-key token can be revoked or expire early; mint a new one once.
            if (
                usesClientCredentials &&
                error instanceof OfferHubError &&
                error.statusCode === 401 &&
                this.config.credentials.invalidate
            ) {
                this.config.credentials.invalidate();
                return this.send<T>(method, path, options);
            }
            throw error;
        }
    }

    /** @internal Like `request`, without the 401 refresh. */
    async send<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
        const url = this.buildUrl(path, options.query);
        const authorization =
            options.authorization !== undefined
                ? options.authorization
                : await this.config.credentials.authorization(this);

        const headers: Record<string, string> = {
            Accept: 'application/json',
            'X-OfferHub-SDK': SDK_VERSION,
            ...this.config.headers,
        };
        if (authorization) headers.Authorization = authorization;
        if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';

        const init: RequestInit = {
            method,
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        };

        const maxAttempts = method === 'GET' ? (this.config.retryAttempts ?? 2) + 1 : 1;
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            let response: Response;
            try {
                response = await this.fetchWithTimeout(url, init);
            } catch (error) {
                lastError = error;
                if (attempt < maxAttempts) {
                    await this.backoff(attempt);
                    continue;
                }
                const timedOut = error instanceof Error && error.name === 'AbortError';
                throw new NetworkError(timedOut ? 'Request timed out' : 'Network request failed', error);
            }

            if (response.ok) {
                return options.envelope ? ((await this.readJson(response)) as T) : this.unwrap<T>(response);
            }

            if (attempt < maxAttempts && RETRYABLE_STATUS.has(response.status)) {
                await this.backoff(attempt);
                continue;
            }

            const body = await this.readJson(response);
            throw parseError(response.status, body, response.headers.get('retry-after'));
        }

        throw new NetworkError('Request failed', lastError);
    }

    private buildUrl(path: string, query?: RequestOptions['query']): string {
        const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
        if (!query) return url;
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) params.set(key, String(value));
        }
        const qs = params.toString();
        return qs ? `${url}?${qs}` : url;
    }

    private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeout ?? 30000);
        try {
            return await this.fetchImpl(url, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    private async backoff(attempt: number): Promise<void> {
        const delay = Math.min(200 * 2 ** (attempt - 1), 3000);
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    private async readJson(response: Response): Promise<unknown> {
        const text = await response.text();
        if (!text) return undefined;
        try {
            return JSON.parse(text);
        } catch {
            return { message: text };
        }
    }

    /**
     * Every success body is `{ data, meta? }`. Cursor-paginated lists come
     * back as `{ data: { data, hasMore, nextCursor } }`, so unwrapping once
     * leaves exactly the page object.
     */
    private async unwrap<T>(response: Response): Promise<T> {
        const body = await this.readJson(response);
        if (isRecord(body) && 'data' in body) {
            return body.data as T;
        }
        return body as T;
    }
}
