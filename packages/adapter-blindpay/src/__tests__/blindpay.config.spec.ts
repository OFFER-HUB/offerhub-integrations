import { BlindPayConfig } from '../blindpay.config';

/* ──────────────────────────────────────────────────────────────────────────────
 * Unit-tests for BlindPayConfig.
 *
 * The config validates on construction, so every case here is "build it and see
 * whether it throws". We save / restore process.env around each test so nothing
 * leaks between them.
 * ────────────────────────────────────────────────────────────────────────────── */

const VALID_ENV = {
    BLINDPAY_ENV: 'development',
    BLINDPAY_API_KEY: 'test_api_key',
    BLINDPAY_BASE_URL: 'https://api.blindpay.com/v1',
    BLINDPAY_INSTANCE_ID: 'in_000000000000',
    BLINDPAY_WEBHOOK_SECRET: 'whsec_test_not_a_real_secret',
    STELLAR_NETWORK: 'testnet',
};

describe('BlindPayConfig', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        Object.assign(process.env, VALID_ENV);
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        jest.restoreAllMocks();
    });

    // ── Required variables ────────────────────────────────────────────────────

    const requiredVars = [
        'BLINDPAY_API_KEY',
        'BLINDPAY_INSTANCE_ID',
        'BLINDPAY_BASE_URL',
        'BLINDPAY_WEBHOOK_SECRET',
    ];

    it.each(requiredVars)('throws a named error when %s is missing', (key) => {
        delete process.env[key];

        expect(() => new BlindPayConfig()).toThrow(
            `Missing required environment variable: ${key}`,
        );
    });

    it.each(requiredVars)('throws when %s is set but empty', (key) => {
        process.env[key] = '';

        expect(() => new BlindPayConfig()).toThrow(
            `Missing required environment variable: ${key}`,
        );
    });

    // ── BLINDPAY_BASE_URL ─────────────────────────────────────────────────────

    it('rejects a BLINDPAY_BASE_URL that is not a valid URL', () => {
        process.env.BLINDPAY_BASE_URL = 'not-a-url';

        expect(() => new BlindPayConfig()).toThrow(/must be a valid URL/);
    });

    it('rejects a non-https BLINDPAY_BASE_URL', () => {
        process.env.BLINDPAY_BASE_URL = 'http://api.blindpay.com/v1';

        expect(() => new BlindPayConfig()).toThrow('BLINDPAY_BASE_URL must use https');
    });

    it('strips trailing slashes so the instance URL has no double slash', () => {
        process.env.BLINDPAY_BASE_URL = 'https://api.blindpay.com/v1//';

        const config = new BlindPayConfig();

        expect(config.baseUrl).toBe('https://api.blindpay.com/v1');
        expect(config.instanceUrl).toBe(
            'https://api.blindpay.com/v1/instances/in_000000000000',
        );
    });

    // ── BLINDPAY_ENV ──────────────────────────────────────────────────────────

    it('rejects an unknown BLINDPAY_ENV', () => {
        process.env.BLINDPAY_ENV = 'staging';

        expect(() => new BlindPayConfig()).toThrow(
            'BLINDPAY_ENV must be "development" or "production"',
        );
    });

    it('defaults to the development environment', () => {
        delete process.env.BLINDPAY_ENV;

        const config = new BlindPayConfig();

        expect(config.environment).toBe('development');
        expect(config.isDevelopment()).toBe(true);
        expect(config.isProduction()).toBe(false);
    });

    // ── Mainnet guard ─────────────────────────────────────────────────────────

    it('refuses a production instance while Stellar is on testnet', () => {
        process.env.BLINDPAY_ENV = 'production';
        process.env.STELLAR_NETWORK = 'testnet';

        expect(() => new BlindPayConfig()).toThrow(
            /BLINDPAY_ENV=production requires STELLAR_NETWORK=mainnet/,
        );
    });

    it('refuses a development instance while Stellar is on mainnet', () => {
        process.env.BLINDPAY_ENV = 'development';
        process.env.STELLAR_NETWORK = 'mainnet';

        expect(() => new BlindPayConfig()).toThrow(
            /STELLAR_NETWORK=mainnet requires BLINDPAY_ENV=production/,
        );
    });

    it('refuses mainnet when BLINDPAY_ENV is left unset', () => {
        delete process.env.BLINDPAY_ENV;
        process.env.STELLAR_NETWORK = 'mainnet';

        expect(() => new BlindPayConfig()).toThrow(
            /STELLAR_NETWORK=mainnet requires BLINDPAY_ENV=production/,
        );
    });

    it('accepts a production instance on mainnet', () => {
        process.env.BLINDPAY_ENV = 'production';
        process.env.STELLAR_NETWORK = 'mainnet';

        const config = new BlindPayConfig();

        expect(config.isProduction()).toBe(true);
    });

    // ── Format warnings (must not block startup) ───────────────────────────────

    it('warns but starts when the instance id has an unexpected prefix', () => {
        process.env.BLINDPAY_INSTANCE_ID = 'QXOd0ahLU9bJ';

        expect(() => new BlindPayConfig()).not.toThrow();
    });

    it('warns but starts when the webhook secret has an unexpected prefix', () => {
        process.env.BLINDPAY_WEBHOOK_SECRET = 'not_a_svix_secret';

        expect(() => new BlindPayConfig()).not.toThrow();
    });

    // ── Happy path ────────────────────────────────────────────────────────────

    it('exposes the values the HTTP client needs', () => {
        const config = new BlindPayConfig();

        expect(config.apiKey).toBe('test_api_key');
        expect(config.instanceId).toBe('in_000000000000');
        expect(config.webhookSecret).toBe('whsec_test_not_a_real_secret');
        expect(config.authorizationHeader).toBe('Bearer test_api_key');
        expect(config.instanceUrl).toBe(
            'https://api.blindpay.com/v1/instances/in_000000000000',
        );
    });
});
