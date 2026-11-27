import { STELLAR_NETWORK_DEFAULTS, TrustlessWorkConfig } from '../trustless-work.config';

/* ──────────────────────────────────────────────────────────────────────────────
 * Unit-tests for TrustlessWorkConfig.
 *
 * The config validates on construction, so every case here is "build it and see
 * whether it throws". We save / restore process.env around each test so nothing
 * leaks between them.
 * ────────────────────────────────────────────────────────────────────────────── */

const BASE_ENV = {
    TRUSTLESS_API_KEY: 'key_id.key_secret',
    TRUSTLESS_WEBHOOK_SECRET: 'tw_whsec_test_not_a_real_secret',
    PLATFORM_USER_ID: 'usr_platform',
};

// Every variable the network switch touches - cleared so the developer's
// local .env can't leak into a test.
const NETWORK_VARS = [
    'STELLAR_NETWORK',
    'STELLAR_RPC_URL',
    'STELLAR_USDC_ASSET_CODE',
    'STELLAR_USDC_ISSUER',
    'TRUSTLESS_API_URL',
    'STELLAR_HORIZON_URL',
];

const MAINNET_RPC = 'https://mainnet.sorobanrpc.com';

describe('TrustlessWorkConfig', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        for (const key of NETWORK_VARS) delete process.env[key];
        Object.assign(process.env, BASE_ENV);
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    // ── Testnet defaults ──────────────────────────────────────────────────────

    it('defaults to testnet with every testnet value', () => {
        const config = new TrustlessWorkConfig();

        expect(config.stellarNetwork).toBe('testnet');
        expect(config.isTestnet()).toBe(true);
        expect(config.stellarRpcUrl).toBe('https://soroban-testnet.stellar.org');
        expect(config.stellarUsdcAssetCode).toBe('USDC');
        expect(config.stellarUsdcIssuer).toBe(STELLAR_NETWORK_DEFAULTS.testnet.usdcIssuer);
        expect(config.apiUrl).toBe('https://dev.api.trustlesswork.com');
    });

    it('rejects an unknown STELLAR_NETWORK', () => {
        process.env.STELLAR_NETWORK = 'futurenet';

        expect(() => new TrustlessWorkConfig()).toThrow('STELLAR_NETWORK must be "testnet" or "mainnet"');
    });

    // ── Mainnet defaults ──────────────────────────────────────────────────────

    it('switches every network-dependent default on mainnet', () => {
        process.env.STELLAR_NETWORK = 'mainnet';
        process.env.STELLAR_RPC_URL = MAINNET_RPC;

        const config = new TrustlessWorkConfig();

        expect(config.isMainnet()).toBe(true);
        expect(config.stellarRpcUrl).toBe(MAINNET_RPC);
        expect(config.stellarUsdcIssuer).toBe('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
        expect(config.apiUrl).toBe('https://api.trustlesswork.com');
    });

    it('requires STELLAR_RPC_URL on mainnet', () => {
        process.env.STELLAR_NETWORK = 'mainnet';

        expect(() => new TrustlessWorkConfig()).toThrow(/STELLAR_RPC_URL is required on mainnet/);
    });

    // ── Leftovers from the other network ──────────────────────────────────────

    it('refuses the testnet USDC issuer on mainnet', () => {
        process.env.STELLAR_NETWORK = 'mainnet';
        process.env.STELLAR_RPC_URL = MAINNET_RPC;
        process.env.STELLAR_USDC_ISSUER = STELLAR_NETWORK_DEFAULTS.testnet.usdcIssuer;

        expect(() => new TrustlessWorkConfig()).toThrow(/STELLAR_USDC_ISSUER is the testnet USDC issuer/);
    });

    it('refuses the mainnet USDC issuer on testnet', () => {
        process.env.STELLAR_USDC_ISSUER = STELLAR_NETWORK_DEFAULTS.mainnet.usdcIssuer;

        expect(() => new TrustlessWorkConfig()).toThrow(/STELLAR_USDC_ISSUER is the mainnet USDC issuer/);
    });

    it('refuses the testnet TrustlessWork API on mainnet', () => {
        process.env.STELLAR_NETWORK = 'mainnet';
        process.env.STELLAR_RPC_URL = MAINNET_RPC;
        process.env.TRUSTLESS_API_URL = 'https://dev.api.trustlesswork.com/';

        expect(() => new TrustlessWorkConfig()).toThrow(/TRUSTLESS_API_URL points at the testnet/);
    });

    it('refuses the mainnet TrustlessWork API on testnet', () => {
        process.env.TRUSTLESS_API_URL = 'https://api.trustlesswork.com';

        expect(() => new TrustlessWorkConfig()).toThrow(/TRUSTLESS_API_URL points at the mainnet/);
    });

    it('refuses a testnet RPC endpoint on mainnet', () => {
        process.env.STELLAR_NETWORK = 'mainnet';
        process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';

        expect(() => new TrustlessWorkConfig()).toThrow(/STELLAR_RPC_URL looks like a test network endpoint/);
    });

    it('accepts overrides that belong to no known network', () => {
        process.env.TRUSTLESS_API_URL = 'http://localhost:9999';
        process.env.STELLAR_RPC_URL = 'http://localhost:8000/soroban/rpc';

        const config = new TrustlessWorkConfig();

        expect(config.apiUrl).toBe('http://localhost:9999');
        expect(config.stellarRpcUrl).toBe('http://localhost:8000/soroban/rpc');
    });

    // ── Format checks ─────────────────────────────────────────────────────────

    it('rejects a malformed USDC issuer', () => {
        process.env.STELLAR_USDC_ISSUER = 'not-a-key';

        expect(() => new TrustlessWorkConfig()).toThrow(/STELLAR_USDC_ISSUER must be a valid Stellar public key/);
    });

    it('rejects an RPC URL without a scheme', () => {
        process.env.STELLAR_RPC_URL = 'soroban-testnet.stellar.org';

        expect(() => new TrustlessWorkConfig()).toThrow('STELLAR_RPC_URL must start with http:// or https://');
    });
});
