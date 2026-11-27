import { Inject, Injectable, Logger } from '@nestjs/common';
import ky, { type KyInstance, HTTPError } from 'ky';
import { BlindPayConfig } from '../blindpay.config';
import { BlindPayProviderException } from '../exceptions';
import type { AuthorizeQuoteDto, CreateCustomerDto, CreatePayoutDto, CreateQuoteDto } from '../dto';
import {
    DEFAULT_RETRY_OPTIONS,
    HTTP_TIMEOUT_MS,
    PAYOUT_SUBMIT_MAX_ATTEMPTS,
    PAYOUT_SUBMIT_RETRY_DELAY_MS,
    PAYOUT_SUBMIT_TIMEOUT_MS,
    type BlindPayAuthorization,
    type BlindPayErrorBody,
    type BlindPayBankAccount,
    type BlindPayCustomer,
    type BlindPayCustomerDetail,
    type BlindPayPayout,
    type BlindPayQuote,
    type BlindPayWebhookEndpoint,
} from '../types';

/**
 * HTTP client for the BlindPay REST API.
 *
 * Every route hangs off the instance-scoped base — BlindPay puts the instance id
 * in the path (`/v1/instances/{id}/...`), not in a header — and carries a Bearer
 * token as the only auth header.
 *
 * Payout flow on Stellar:
 *   1. createQuote()      locks the rate for 5 minutes
 *   2. authorizeQuote()   returns an unsigned transaction
 *   3. (client signs it and submits it to the Stellar network)
 *   4. createPayout()     hands BlindPay the signed envelope
 */
@Injectable()
export class BlindPayService {
    private readonly logger = new Logger(BlindPayService.name);
    private readonly client: KyInstance;

    constructor(@Inject(BlindPayConfig) private readonly config: BlindPayConfig) {
        this.client = ky.create({
            prefixUrl: this.config.instanceUrl,
            timeout: HTTP_TIMEOUT_MS,
            retry: {
                limit: DEFAULT_RETRY_OPTIONS.maxRetries,
                // Deliberately GET-only: a POST that timed out may already have
                // created a quote or a payout on their side.
                methods: ['get'],
                statusCodes: [...DEFAULT_RETRY_OPTIONS.retryStatusCodes],
                backoffLimit: DEFAULT_RETRY_OPTIONS.maxDelayMs,
            },
            hooks: {
                beforeRequest: [
                    (request) => {
                        request.headers.set('Authorization', this.config.authorizationHeader);
                        request.headers.set('Content-Type', 'application/json');
                        request.headers.set('Accept', 'application/json');
                        this.logger.debug(
                            `[BlindPay] ${request.method} ${this.maskUrl(request.url)}`,
                        );
                    },
                ],
                beforeRetry: [
                    ({ retryCount, error }) => {
                        this.logger.warn(
                            `[BlindPay] Retry ${retryCount}/${DEFAULT_RETRY_OPTIONS.maxRetries}: ` +
                                (error instanceof Error ? error.message : 'Unknown error'),
                        );
                    },
                ],
            },
        });
    }

    /**
     * Registers the freelancer as a BlindPay customer.
     *
     * A bank account can only be created under a customer, so this runs first
     * the one time a user is paid out. Confirmed live against a real dev
     * instance while building issue #249: a `standard`-tier individual
     * auto-approves in seconds on a development instance (`kyc_status:
     * "approved"` on creation); `enhanced` always gets a manual review on
     * BlindPay's side (up to 1 business day), dev instance or not.
     *
     * See `CreateCustomerDto` for where every field here was verified.
     */
    async createCustomer(params: CreateCustomerDto): Promise<BlindPayCustomer> {
        return this.post<BlindPayCustomer>('customers', {
            email: params.email,
            country: params.country,
            type: params.type ?? 'individual',
            kyc_type: params.kycType,
            first_name: params.firstName,
            last_name: params.lastName,
            date_of_birth: params.dateOfBirth,
            tax_id: params.taxId,
            address_line_1: params.addressLine1,
            address_line_2: params.addressLine2,
            city: params.city,
            state_province_region: params.stateProvinceRegion,
            postal_code: params.postalCode,
            id_doc_country: params.idDocCountry,
            id_doc_type: params.idDocType,
            selfie_file: params.selfieFile,
            id_doc_front_file: params.idDocFrontFile,
            id_doc_back_file: params.idDocBackFile,
            tos_id: params.tosId,
            proof_of_address_doc_type: params.proofOfAddressDocType,
            proof_of_address_doc_file: params.proofOfAddressDocFile,
            source_of_funds_doc_type: params.sourceOfFundsDocType,
            source_of_funds_doc_file: params.sourceOfFundsDocFile,
            purpose_of_transactions: params.purposeOfTransactions,
            purpose_of_transactions_explanation: params.purposeOfTransactionsExplanation,
        });
    }

    /**
     * Every customer on the instance. BlindPay ignores an `email` query
     * parameter here (checked against production), so callers match locally.
     */
    async listCustomers(): Promise<BlindPayCustomer[]> {
        return this.get<BlindPayCustomer[]>('customers');
    }

    /** One customer with its full KYC submission. */
    async getCustomer(customerId: string): Promise<BlindPayCustomerDetail> {
        return this.get<BlindPayCustomerDetail>(`customers/${encodeURIComponent(customerId)}`);
    }

    /**
     * Starts BlindPay's terms-of-service acceptance flow.
     *
     * BlindPay only accepts ToS acceptance from a real browser session at
     * `app.blindpay.com` — a server-side POST to accept on the customer's
     * behalf is rejected outright. So this returns a URL for the freelancer to
     * open themselves; BlindPay redirects them back to `redirectUrl` with a
     * `tos_id` query parameter once they accept, which is what gets passed to
     * `createCustomer`. Confirmed live while building issue #249 — see
     * `references/essentials/terms-of-service.md` in the `blindpay` skill.
     *
     * `idempotencyKey` must be a fresh UUID per call; BlindPay rejects reusing
     * one from an earlier request.
     */
    async generateTosUrl(idempotencyKey: string, redirectUrl?: string): Promise<string> {
        // Lives under a different path shape than every other call in this
        // class — /e/instances/{id}/tos, not /instances/{id}/tos — so this
        // passes ky an absolute URL, which takes priority over the client's
        // prefixUrl instead of being joined with it.
        const tosUrl = `${this.config.baseUrl}/e/instances/${this.config.instanceId}/tos`;
        const { url } = await this.post<{ url: string }>(tosUrl, {
            idempotency_key: idempotencyKey,
            redirect_url: redirectUrl ?? this.config.tosRedirectUrl,
        });
        return url;
    }

    /**
     * Registers a destination account under a customer.
     *
     * The body is rail-shaped: BlindPay asks for `pix_key` on PIX, `spei_clabe`
     * and `spei_protocol` on SPEI, and so on, so the caller assembles it from
     * the account's stored details rather than this method guessing.
     */
    async createBankAccount(
        customerId: string,
        body: Record<string, unknown>,
    ): Promise<BlindPayBankAccount> {
        return this.post<BlindPayBankAccount>(`customers/${customerId}/bank-accounts`, body);
    }

    /**
     * Locks the exchange rate and fee split for a payout.
     *
     * The quote is valid for five minutes; `expires_at` comes back in epoch
     * MILLISECONDS and has to be checked before authorizing.
     */
    async createQuote(params: CreateQuoteDto): Promise<BlindPayQuote> {
        return this.post<BlindPayQuote>('quotes', {
            bank_account_id: params.bankAccountId,
            request_amount: params.requestAmount,
            currency_type: params.currencyType,
            cover_fees: params.coverFees ?? false,
            // Never hardcoded at the call site: T3 flips these with one env var.
            network: params.network ?? this.config.network,
            token: params.token ?? this.config.token,
        });
    }

    /**
     * Asks BlindPay for the unsigned transaction that funds the payout.
     *
     * Note the signature differs from the one sketched in the issue
     * (`authorizeQuote(quoteId)` against `POST /quotes/:id/authorize`): that
     * route does not exist. The real endpoint is `POST /payouts/stellar/authorize`
     * and it needs the funding wallet as well as the quote.
     */
    async authorizeQuote(params: AuthorizeQuoteDto): Promise<BlindPayAuthorization> {
        return this.post<BlindPayAuthorization>('payouts/stellar/authorize', {
            quote_id: params.quoteId,
            sender_wallet_address: params.senderWalletAddress,
        });
    }

    /**
     * Dispatches the payout with the signed Stellar transaction.
     *
     * BlindPay re-validates the envelope against the quote (destination and
     * amount) before sending money, so a mismatched signature is rejected there.
     */
    async createPayout(params: CreatePayoutDto): Promise<BlindPayPayout> {
        // Same key and the same body bytes on every attempt: BlindPay then replays
        // the first answer instead of creating a second payout (its Idempotency-Key
        // contract), so a timeout can be retried safely. One quote is one payout,
        // which makes the quote id a natural key.
        const body = {
            quote_id: params.quoteId,
            signed_transaction: params.signedTransaction,
            sender_wallet_address: params.senderWalletAddress,
        };
        const options = {
            idempotencyKey: `offerhub-stellar-payout-${params.quoteId}`,
            timeoutMs: PAYOUT_SUBMIT_TIMEOUT_MS,
        };

        for (let attempt = 1; ; attempt++) {
            try {
                return await this.request<BlindPayPayout>('post', 'payouts/stellar', body, options);
            } catch (error) {
                if (attempt >= PAYOUT_SUBMIT_MAX_ATTEMPTS || !BlindPayService.isRetriableSubmit(error)) {
                    throw error;
                }
                this.logger.warn(
                    `[BlindPay] POST payouts/stellar attempt ${attempt} had no answer; retrying with the same Idempotency-Key`,
                );
                await this.wait(PAYOUT_SUBMIT_RETRY_DELAY_MS * attempt);
            }
        }
    }

    /** Pause between submit retries; its own method so tests can skip the wait. */
    protected wait(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Retry only when there was no answer (our timeout, or a 408/504 gateway
     * timeout) or BlindPay says the first attempt is still running (409
     * idempotency_key_in_flight). Those replay the first attempt under the same
     * key. Any other error is a real answer and is returned: a 5xx in particular
     * releases the key on BlindPay's side, so resending it would be a new attempt,
     * and a failed POST is never resent.
     */
    private static isRetriableSubmit(error: unknown): boolean {
        if (!(error instanceof BlindPayProviderException)) return false;
        const response = error.getResponse() as { error?: { message?: string; details?: { originalStatus?: number } } };
        const status = response.error?.details?.originalStatus ?? 0;
        if (status === 409) return /idempotency_key_in_flight/i.test(response.error?.message ?? '');
        return status === 408 || status === 504;
    }

    /**
     * Reads the current state of a payout, including the per-stage tracking.
     */
    async getPayoutStatus(payoutId: string): Promise<BlindPayPayout> {
        return this.get<BlindPayPayout>(`payouts/${payoutId}`);
    }

    /**
     * One page of the instance's payouts, newest first. BlindPay only accepts
     * a page size of 10, 50, 100, 200, 500 or 1000 (checked live) and answers
     * `{ data, pagination: { has_more, next_page } }`; `next_page` is the id to
     * pass as `startingAfter` for the following page.
     */
    async listPayouts(
        limit: 10 | 50 | 100 | 200 | 500 | 1000 = 100,
        startingAfter?: string,
    ): Promise<{ data: BlindPayPayout[]; hasMore: boolean; nextPage: string | null }> {
        const query = new URLSearchParams({ limit: String(limit) });
        if (startingAfter) {
            query.set('starting_after', startingAfter);
        }
        const page = await this.get<{
            data: BlindPayPayout[];
            pagination?: { has_more?: boolean; next_page?: string | null };
        }>(`payouts?${query.toString()}`);
        return {
            data: page.data ?? [],
            hasMore: page.pagination?.has_more === true,
            nextPage: page.pagination?.next_page ?? null,
        };
    }

    /**
     * Finds the payout a quote turned into, or `null` when BlindPay has none.
     * This is how an ambiguous submit (the POST timed out, so OfferHub never
     * learned the payout id) is confirmed instead of assumed. BlindPay has no
     * filter by quote, so it pages through the most recent payouts, bounded by
     * `maxPages` so a lookup can never run away.
     */
    async findPayoutByQuoteId(quoteId: string, maxPages = 5): Promise<BlindPayPayout | null> {
        let cursor: string | undefined;
        for (let page = 0; page < maxPages; page++) {
            const result = await this.listPayouts(100, cursor);
            const match = result.data.find((payout) => payout.quote_id === quoteId);
            if (match) {
                return match;
            }
            if (!result.hasMore || !result.nextPage) {
                return null;
            }
            cursor = result.nextPage;
        }
        return null;
    }

    /**
     * Testnet-only: asks BlindPay for the unsigned trustline transaction that
     * lets `address` hold USDB, their own test stablecoin. Development
     * instances settle every quote/payout in USDB rather than real USDC, so a
     * non-custodial seller needs this before they can fund a test payout —
     * see `WalletService.prepareUsdbTrustline`.
     */
    async createUsdbTrustline(address: string): Promise<{ xdr: string }> {
        return this.post<{ xdr: string }>('create-asset-trustline', { address });
    }

    /**
     * Testnet-only: submits the seller-signed trustline transaction and mints
     * `amount` USDB into it. Companion to `createUsdbTrustline` — see
     * `WalletService.submitUsdbTrustline`.
     */
    async mintUsdb(address: string, amount: string, signedXdr: string): Promise<{ success: boolean }> {
        return this.post<{ success: boolean }>('mint-usdb-stellar', { address, amount, signedXdr });
    }

    /**
     * Registers a webhook endpoint.
     *
     * An empty `events` array subscribes to every event, which is BlindPay's own
     * default. The signing secret is per endpoint and is read from the dashboard
     * into BLINDPAY_WEBHOOK_SECRET.
     */
    async registerWebhook(url: string, events: string[] = []): Promise<void> {
        await this.post<BlindPayWebhookEndpoint>('webhook-endpoints', { url, events });
    }

    private async get<T>(path: string): Promise<T> {
        return this.request<T>('get', path);
    }

    private async post<T>(path: string, body: unknown): Promise<T> {
        return this.request<T>('post', path, body);
    }

    private async request<T>(
        method: 'get' | 'post',
        path: string,
        body?: unknown,
        options: { idempotencyKey?: string; timeoutMs?: number } = {},
    ): Promise<T> {
        try {
            // ky joins a relative `path` onto the client's prefixUrl but has no
            // notion of "already absolute" — it would otherwise concatenate the
            // instance-scoped prefixUrl onto generateTosUrl's full URL (a
            // different path shape, /e/instances/... vs /instances/...) and
            // produce garbage. Dropping prefixUrl for just this call is what
            // lets an absolute `path` pass through untouched.
            const client = /^https?:\/\//.test(path) ? this.client.extend({ prefixUrl: '' }) : this.client;
            const response =
                method === 'get'
                    ? await client.get(path)
                    : await client.post(path, {
                          json: body,
                          ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
                          ...(options.idempotencyKey ? { headers: { 'Idempotency-Key': options.idempotencyKey } } : {}),
                      });
            return await response.json<T>();
        } catch (error) {
            throw await this.toProviderException(error, method, path, options.timeoutMs);
        }
    }

    /**
     * Turns any transport failure into a BlindPayProviderException carrying a
     * message a human can act on — BlindPay puts its validation detail in the
     * response body, which ky's own error message does not include.
     */
    private async toProviderException(
        error: unknown,
        method: string,
        path: string,
        timeoutMs: number = HTTP_TIMEOUT_MS,
    ): Promise<BlindPayProviderException> {
        let statusCode = 502;
        let message = 'External provider error';

        if (error instanceof HTTPError) {
            statusCode = error.response.status;
            message = (await this.extractMessage(error)) ?? error.message;
        } else if (error instanceof Error) {
            if (error.name === 'TimeoutError') {
                statusCode = 504;
                message = `Request timed out after ${timeoutMs}ms`;
            } else {
                message = error.message;
            }
        }

        this.logger.error(`[BlindPay] ${method.toUpperCase()} ${path} failed: ${message}`);

        return new BlindPayProviderException(message, method, path, statusCode);
    }

    /**
     * Reads BlindPay's error envelope: a top-level message plus a list of
     * per-field validation errors.
     */
    private async extractMessage(error: HTTPError): Promise<string | null> {
        try {
            const body = (await error.response.json()) as BlindPayErrorBody;
            if (!body?.message) return null;

            const details = (body.errors ?? [])
                .map((e) => {
                    const field = e.path?.join('.');
                    return field ? `${field}: ${e.message}` : e.message;
                })
                .filter((detail): detail is string => Boolean(detail));

            return details.length > 0 ? `${body.message} (${details.join('; ')})` : body.message;
        } catch {
            return null;
        }
    }

    /**
     * Masks long identifiers so request logs never carry a full id or token.
     */
    private maskUrl(url: string): string {
        try {
            const parsed = new URL(url);
            return `${parsed.pathname}${parsed.search}`.replace(/[a-zA-Z0-9_-]{20,}/g, '***');
        } catch {
            return url.replace(/[a-zA-Z0-9_-]{20,}/g, '***');
        }
    }
}
