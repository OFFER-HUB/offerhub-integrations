import { Test, TestingModule } from '@nestjs/testing';
import { BlindPayService } from '../services/blindpay.service';
import { BlindPayConfig } from '../blindpay.config';
import { BlindPayProviderException } from '../exceptions';

// Mock ky module (ESM) so the client never makes real HTTP calls
jest.mock('ky', () => {
    const mockResponse = { json: jest.fn() };
    const mockClient = {
        get: jest.fn().mockReturnValue(mockResponse),
        post: jest.fn().mockReturnValue(mockResponse),
    };
    return {
        __esModule: true,
        default: { create: jest.fn().mockReturnValue(mockClient) },
        HTTPError: class HTTPError extends Error {
            response: { status: number; json: () => Promise<unknown> };
            constructor(message: string, status: number, body?: unknown) {
                super(message);
                this.name = 'HTTPError';
                this.response = {
                    status,
                    json: () =>
                        body === undefined
                            ? Promise.reject(new Error('no body'))
                            : Promise.resolve(body),
                };
            }
        },
    };
});

const mockConfig = {
    instanceUrl: 'https://api.blindpay.com/v1/instances/in_000000000000',
    authorizationHeader: 'Bearer test_api_key',
    network: 'stellar_testnet',
    token: 'USDB',
} as unknown as BlindPayConfig;

const quote = {
    id: 'qu_test',
    expires_at: 1_800_000_000_000,
    commercial_quotation: 100,
    blindpay_quotation: 100,
    sender_amount: 10000,
    receiver_amount: 10000,
    partner_fee_amount: null,
    flat_fee: 0,
    billing_fee_amount: 0,
    contract: null,
};

describe('BlindPayService', () => {
    let service: BlindPayService;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockKy: any;

    beforeEach(async () => {
        jest.clearAllMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        mockKy = require('ky').default.create();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BlindPayService,
                { provide: BlindPayConfig, useValue: mockConfig },
            ],
        }).compile();

        service = module.get<BlindPayService>(BlindPayService);
    });

    // ── createQuote ───────────────────────────────────────────────────────────

    describe('createQuote', () => {
        it('posts to /quotes and returns the quote', async () => {
            mockKy.post().json.mockResolvedValueOnce(quote);

            const result = await service.createQuote({
                bankAccountId: 'ba_6BcdN9ltKW9R',
                requestAmount: 10000,
                currencyType: 'sender',
            });

            expect(result).toEqual(quote);
            const [path, options] = mockKy.post.mock.calls.at(-1);
            expect(path).toBe('quotes');
            expect(options.json).toEqual({
                bank_account_id: 'ba_6BcdN9ltKW9R',
                request_amount: 10000,
                currency_type: 'sender',
                cover_fees: false,
                network: 'stellar_testnet',
                token: 'USDB',
            });
        });

        it('fills network and token from config so callers never hardcode them', async () => {
            mockKy.post().json.mockResolvedValueOnce(quote);

            await service.createQuote({
                bankAccountId: 'ba_6BcdN9ltKW9R',
                requestAmount: 5000,
                currencyType: 'receiver',
            });

            const [, options] = mockKy.post.mock.calls.at(-1);
            expect(options.json.network).toBe('stellar_testnet');
            expect(options.json.token).toBe('USDB');
        });

        it('lets an explicit network and token override the config', async () => {
            mockKy.post().json.mockResolvedValueOnce(quote);

            await service.createQuote({
                bankAccountId: 'ba_6BcdN9ltKW9R',
                requestAmount: 5000,
                currencyType: 'sender',
                network: 'stellar',
                token: 'USDC',
                coverFees: true,
            });

            const [, options] = mockKy.post.mock.calls.at(-1);
            expect(options.json.network).toBe('stellar');
            expect(options.json.token).toBe('USDC');
            expect(options.json.cover_fees).toBe(true);
        });
    });

    // ── createCustomer ────────────────────────────────────────────────────────

    const standardCustomerParams = {
        email: 'ada@example.com',
        country: 'MX',
        kycType: 'standard' as const,
        firstName: 'Ada',
        lastName: 'Lovelace',
        dateOfBirth: '1990-01-01T00:00:00.000Z',
        taxId: 'RFC123456ABC',
        addressLine1: 'Calle Falsa 123',
        city: 'Ciudad de Mexico',
        stateProvinceRegion: 'CDMX',
        postalCode: '01000',
        idDocCountry: 'MX',
        idDocType: 'PASSPORT' as const,
        selfieFile: 'https://cdn.example.com/selfie.jpg',
        idDocFrontFile: 'https://cdn.example.com/id-front.jpg',
        tosId: 'tos_123456789012345',
    };

    describe('createCustomer', () => {
        it('posts to /customers with the full compliance dossier', async () => {
            mockKy.post().json.mockResolvedValueOnce({ id: 're_test', kyc_status: 'approved' });

            const result = await service.createCustomer(standardCustomerParams);

            expect(result.id).toBe('re_test');
            const [path, options] = mockKy.post.mock.calls.at(-1);
            expect(path).toBe('customers');
            expect(options.json).toEqual({
                email: 'ada@example.com',
                country: 'MX',
                type: 'individual',
                kyc_type: 'standard',
                first_name: 'Ada',
                last_name: 'Lovelace',
                date_of_birth: '1990-01-01T00:00:00.000Z',
                tax_id: 'RFC123456ABC',
                address_line_1: 'Calle Falsa 123',
                address_line_2: undefined,
                city: 'Ciudad de Mexico',
                state_province_region: 'CDMX',
                postal_code: '01000',
                id_doc_country: 'MX',
                id_doc_type: 'PASSPORT',
                selfie_file: 'https://cdn.example.com/selfie.jpg',
                id_doc_front_file: 'https://cdn.example.com/id-front.jpg',
                id_doc_back_file: undefined,
                tos_id: 'tos_123456789012345',
                proof_of_address_doc_type: undefined,
                proof_of_address_doc_file: undefined,
                source_of_funds_doc_type: undefined,
                source_of_funds_doc_file: undefined,
                purpose_of_transactions: undefined,
                purpose_of_transactions_explanation: undefined,
            });
        });

        it('forwards explicit type and kycType overrides, plus enhanced-tier fields', async () => {
            mockKy.post().json.mockResolvedValueOnce({ id: 're_test2', kyc_status: 'pending' });

            await service.createCustomer({
                ...standardCustomerParams,
                country: 'CO',
                type: 'business',
                kycType: 'enhanced',
                proofOfAddressDocType: 'UTILITY_BILL',
                proofOfAddressDocFile: 'https://cdn.example.com/proof-of-address.jpg',
                sourceOfFundsDocType: 'salary',
                sourceOfFundsDocFile: 'https://cdn.example.com/source-of-funds.jpg',
                purposeOfTransactions: 'receive_salary',
            });

            const [, options] = mockKy.post.mock.calls.at(-1);
            expect(options.json.type).toBe('business');
            expect(options.json.kyc_type).toBe('enhanced');
            // proof_of_address_doc_type stays uppercase — only source_of_funds_doc_type
            // and purpose_of_transactions are lowercase on BlindPay's side, confirmed
            // live while building issue #249.
            expect(options.json.proof_of_address_doc_type).toBe('UTILITY_BILL');
            expect(options.json.source_of_funds_doc_type).toBe('salary');
            expect(options.json.purpose_of_transactions).toBe('receive_salary');
        });
    });

    // ── createBankAccount ─────────────────────────────────────────────────────

    describe('createBankAccount', () => {
        it('posts the body to customers/:id/bank-accounts', async () => {
            mockKy.post().json.mockResolvedValueOnce({ id: 'ba_new123' });

            const result = await service.createBankAccount('re_test', {
                type: 'spei_bitso',
                name: 'BBVA',
                beneficiary_name: 'Ada Lovelace',
                spei_clabe: '012180012345678901',
                spei_protocol: 'clabe',
            });

            expect(result.id).toBe('ba_new123');
            const [path, options] = mockKy.post.mock.calls.at(-1);
            expect(path).toBe('customers/re_test/bank-accounts');
            expect(options.json).toMatchObject({ type: 'spei_bitso', name: 'BBVA' });
        });

        it('passes through any rail-specific fields untouched', async () => {
            mockKy.post().json.mockResolvedValueOnce({ id: 'ba_pix' });

            await service.createBankAccount('re_pix', { type: 'pix', pix_key: 'ada@pix.br' });

            const [, options] = mockKy.post.mock.calls.at(-1);
            expect(options.json).toEqual({ type: 'pix', pix_key: 'ada@pix.br' });
        });
    });

    // ── authorizeQuote ────────────────────────────────────────────────────────

    it('authorizeQuote posts the quote and wallet to the Stellar authorize route', async () => {
        mockKy.post().json.mockResolvedValueOnce({ transaction_hash: 'AAAA...' });

        const result = await service.authorizeQuote({
            quoteId: 'qu_test',
            senderWalletAddress: 'GABC',
        });

        expect(result.transaction_hash).toBe('AAAA...');
        const [path, options] = mockKy.post.mock.calls.at(-1);
        expect(path).toBe('payouts/stellar/authorize');
        expect(options.json).toEqual({ quote_id: 'qu_test', sender_wallet_address: 'GABC' });
    });

    // ── createPayout ──────────────────────────────────────────────────────────

    it('createPayout posts the signed envelope to the Stellar payout route', async () => {
        mockKy.post().json.mockResolvedValueOnce({ id: 'po_test', status: 'processing' });

        const result = await service.createPayout({
            quoteId: 'qu_test',
            signedTransaction: 'SIGNED_XDR',
            senderWalletAddress: 'GABC',
        });

        expect(result.id).toBe('po_test');
        const [path, options] = mockKy.post.mock.calls.at(-1);
        expect(path).toBe('payouts/stellar');
        expect(options.json).toEqual({
            quote_id: 'qu_test',
            signed_transaction: 'SIGNED_XDR',
            sender_wallet_address: 'GABC',
        });
    });

    describe('createPayout retries without paying twice', () => {
        const { HTTPError } = require('ky');
        const params = { quoteId: 'qu_test', signedTransaction: 'SIGNED_XDR', senderWalletAddress: 'GABC' };
        const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

        beforeEach(() => {
            jest.spyOn(service as never, 'wait' as never).mockResolvedValue(undefined as never);
        });

        it('sends an Idempotency-Key tied to the quote and waits longer than other calls', async () => {
            mockKy.post().json.mockResolvedValueOnce({ id: 'po_test', status: 'processing' });
            mockKy.post.mockClear();

            await service.createPayout(params);

            const [, options] = mockKy.post.mock.calls[0];
            expect(options.headers).toEqual({ 'Idempotency-Key': 'offerhub-stellar-payout-qu_test' });
            expect(options.timeout).toBe(60_000);
        });

        it('retries a timeout with the same key and the same body, and returns the replayed payout', async () => {
            mockKy.post.mockClear();
            mockKy.post
                .mockImplementationOnce(() => Promise.reject(timeout()))
                .mockImplementationOnce(() => ({ json: () => Promise.resolve({ id: 'po_test', status: 'processing' }) }));

            const result = await service.createPayout(params);

            expect(result.id).toBe('po_test');
            expect(mockKy.post).toHaveBeenCalledTimes(2);
            const [first, second] = mockKy.post.mock.calls;
            expect(second[1].headers).toEqual(first[1].headers);
            expect(JSON.stringify(second[1].json)).toBe(JSON.stringify(first[1].json));
        });

        it('retries while BlindPay says the first attempt is still running (409 idempotency_key_in_flight)', async () => {
            mockKy.post.mockClear();
            mockKy.post
                .mockImplementationOnce(() => Promise.reject(new HTTPError('conflict', 409, { message: 'idempotency_key_in_flight' })))
                .mockImplementationOnce(() => ({ json: () => Promise.resolve({ id: 'po_test', status: 'processing' }) }));

            await expect(service.createPayout(params)).resolves.toMatchObject({ id: 'po_test' });
            expect(mockKy.post).toHaveBeenCalledTimes(2);
        });

        it('does not resend after a 5xx answer (BlindPay released the key, so it would be a new attempt)', async () => {
            mockKy.post.mockClear();
            mockKy.post.mockImplementationOnce(() => Promise.reject(new HTTPError('unavailable', 503, { message: 'maintenance' })));

            await expect(service.createPayout(params)).rejects.toBeInstanceOf(BlindPayProviderException);
            expect(mockKy.post).toHaveBeenCalledTimes(1);
        });

        it('does not retry a real rejection (4xx)', async () => {
            mockKy.post.mockClear();
            mockKy.post.mockImplementationOnce(() => Promise.reject(new HTTPError('bad', 400, { message: 'quote expired' })));

            await expect(service.createPayout(params)).rejects.toBeInstanceOf(BlindPayProviderException);
            expect(mockKy.post).toHaveBeenCalledTimes(1);
        });

        it('gives up after 3 attempts and reports the timeout', async () => {
            mockKy.post.mockClear();
            mockKy.post.mockImplementation(() => Promise.reject(timeout()));

            await expect(service.createPayout(params)).rejects.toMatchObject({
                response: { error: { message: 'Request timed out after 60000ms' } },
            });
            expect(mockKy.post).toHaveBeenCalledTimes(3);
            mockKy.post.mockReset();
            mockKy.post.mockReturnValue({ json: jest.fn() });
        });
    });

    // ── getPayoutStatus ───────────────────────────────────────────────────────

    it('getPayoutStatus reads the payout by id', async () => {
        mockKy.get().json.mockResolvedValueOnce({ id: 'po_test', status: 'completed' });

        const result = await service.getPayoutStatus('po_test');

        expect(result.status).toBe('completed');
        expect(mockKy.get.mock.calls.at(-1)[0]).toBe('payouts/po_test');
    });

    // ── listPayouts / findPayoutByQuoteId ────────────────────────────────────

    describe('listPayouts', () => {
        it('reads one page and maps the pagination', async () => {
            mockKy.get().json.mockResolvedValueOnce({
                data: [{ id: 'po_1', quote_id: 'qu_1' }],
                pagination: { has_more: true, next_page: 'po_1' },
            });

            const page = await service.listPayouts(50, 'po_0');

            expect(page).toEqual({ data: [{ id: 'po_1', quote_id: 'qu_1' }], hasMore: true, nextPage: 'po_1' });
            expect(mockKy.get.mock.calls.at(-1)[0]).toBe('payouts?limit=50&starting_after=po_0');
        });

        it('tolerates a response without pagination', async () => {
            mockKy.get().json.mockResolvedValueOnce({ data: [] });

            expect(await service.listPayouts()).toEqual({ data: [], hasMore: false, nextPage: null });
            expect(mockKy.get.mock.calls.at(-1)[0]).toBe('payouts?limit=100');
        });
    });

    describe('findPayoutByQuoteId', () => {
        it('returns the payout found on the first page', async () => {
            mockKy.get().json.mockResolvedValueOnce({
                data: [{ id: 'po_a', quote_id: 'qu_x' }, { id: 'po_b', quote_id: 'qu_target' }],
                pagination: { has_more: true, next_page: 'po_b' },
            });

            mockKy.get.mockClear();

            const found = await service.findPayoutByQuoteId('qu_target');

            expect(found?.id).toBe('po_b');
            expect(mockKy.get).toHaveBeenCalledTimes(1);
        });

        it('keeps paging until it finds the quote', async () => {
            mockKy.get().json
                .mockResolvedValueOnce({ data: [{ id: 'po_a', quote_id: 'qu_x' }], pagination: { has_more: true, next_page: 'po_a' } })
                .mockResolvedValueOnce({ data: [{ id: 'po_c', quote_id: 'qu_target' }], pagination: { has_more: false, next_page: null } });

            const found = await service.findPayoutByQuoteId('qu_target');

            expect(found?.id).toBe('po_c');
            expect(mockKy.get.mock.calls.at(-1)[0]).toBe('payouts?limit=100&starting_after=po_a');
        });

        it('returns null once the last page has no match', async () => {
            mockKy.get().json.mockResolvedValueOnce({
                data: [{ id: 'po_a', quote_id: 'qu_x' }],
                pagination: { has_more: false, next_page: null },
            });

            expect(await service.findPayoutByQuoteId('qu_target')).toBeNull();
        });

        it('stops at maxPages instead of paging forever', async () => {
            mockKy.get().json.mockResolvedValue({
                data: [{ id: 'po_a', quote_id: 'qu_x' }],
                pagination: { has_more: true, next_page: 'po_a' },
            });

            mockKy.get.mockClear();

            expect(await service.findPayoutByQuoteId('qu_target', 3)).toBeNull();
            expect(mockKy.get).toHaveBeenCalledTimes(3);
        });
    });

    // ── registerWebhook ───────────────────────────────────────────────────────

    it('registerWebhook posts to webhook-endpoints and defaults to every event', async () => {
        mockKy.post().json.mockResolvedValueOnce({ id: 'we_test' });

        await service.registerWebhook('https://offer-hub.org/api/v1/webhooks/blindpay');

        const [path, options] = mockKy.post.mock.calls.at(-1);
        expect(path).toBe('webhook-endpoints');
        expect(options.json).toEqual({
            url: 'https://offer-hub.org/api/v1/webhooks/blindpay',
            events: [],
        });
    });

    // ── Error mapping ─────────────────────────────────────────────────────────

    describe('error mapping', () => {
        const { HTTPError } = require('ky');

        it('surfaces BlindPay validation detail in the message', async () => {
            mockKy.post().json.mockRejectedValueOnce(
                new HTTPError('Request failed', 400, {
                    success: false,
                    message: 'One or more params are not valid',
                    errors: [{ path: ['network'], message: 'Invalid enum value' }],
                }),
            );

            await expect(
                service.createQuote({
                    bankAccountId: 'ba_x',
                    requestAmount: 1,
                    currencyType: 'sender',
                }),
            ).rejects.toMatchObject({
                code: 'PROVIDER_ERROR',
                response: {
                    error: {
                        message: 'One or more params are not valid (network: Invalid enum value)',
                    },
                },
            });
        });

        it('maps 429 to PROVIDER_RATE_LIMITED', async () => {
            mockKy.get().json.mockRejectedValueOnce(new HTTPError('Too many requests', 429));

            await expect(service.getPayoutStatus('po_test')).rejects.toMatchObject({
                code: 'PROVIDER_RATE_LIMITED',
            });
        });

        it('maps a timeout to PROVIDER_TIMEOUT', async () => {
            const timeout = new Error('Request timed out');
            timeout.name = 'TimeoutError';
            mockKy.get().json.mockRejectedValueOnce(timeout);

            await expect(service.getPayoutStatus('po_test')).rejects.toMatchObject({
                code: 'PROVIDER_TIMEOUT',
            });
        });

        it('always throws BlindPayProviderException, never a raw HTTP error', async () => {
            mockKy.get().json.mockRejectedValueOnce(new HTTPError('Boom', 500));

            await expect(service.getPayoutStatus('po_test')).rejects.toBeInstanceOf(
                BlindPayProviderException,
            );
        });
    });
});
