import { Keypair, Networks } from '@stellar/stellar-sdk';
import { ConfigError, loadConfig } from '../config';

const buyer = Keypair.random();
const sellerMx = Keypair.random();
const sellerBr = Keypair.random();

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
        VALIDATION_API_URL: 'https://api.example.com/api/v1/',
        VALIDATION_NETWORK: 'mainnet',
        VALIDATION_RPC_URL: 'https://rpc.example.com',
        VALIDATION_BUYER_SECRET: buyer.secret(),
        VALIDATION_SELLERS: JSON.stringify([
            { corridor: 'MX', secret: sellerMx.secret() },
            { corridor: 'BR', secret: sellerBr.secret() },
        ]),
        VALIDATION_AMOUNT_USDC: '10.56',
        VALIDATION_MIN_BALANCE_USDC: '20',
        VALIDATION_BLINDPAY_INSTANCE_ID: 'in_123',
        VALIDATION_BLINDPAY_API_KEY: 'bp_key',
        ...overrides,
    };
}

describe('loadConfig', () => {
    it('parses a complete mainnet configuration', () => {
        const config = loadConfig(env());
        expect(config.apiUrl).toBe('https://api.example.com/api/v1');
        expect(config.networkPassphrase).toBe(Networks.PUBLIC);
        expect(config.usdcIssuer).toBe('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
        expect(config.sellers.map((s) => s.corridor)).toEqual(['MX', 'BR']);
        expect(config.sellers[0].keypair.publicKey()).toBe(sellerMx.publicKey());
        expect(config.payoutTimeoutMs).toBe(30 * 60_000);
    });

    it('defaults the RPC URL on testnet only', () => {
        expect(loadConfig(env({ VALIDATION_NETWORK: 'testnet', VALIDATION_RPC_URL: undefined })).rpcUrl).toBe(
            'https://soroban-testnet.stellar.org',
        );
        expect(() => loadConfig(env({ VALIDATION_RPC_URL: undefined }))).toThrow(/VALIDATION_RPC_URL/);
    });

    it('never echoes a malformed secret in the error', () => {
        const bad = 'SNOTAREALSECRETBUTSHOULDNOTLEAK';
        try {
            loadConfig(env({ VALIDATION_BUYER_SECRET: bad }));
            throw new Error('expected a ConfigError');
        } catch (error: unknown) {
            expect(error).toBeInstanceOf(ConfigError);
            expect((error as Error).message).not.toContain(bad);
        }
    });

    it('rejects unsupported or duplicated corridors and a buyer reused as seller', () => {
        expect(() => loadConfig(env({ VALIDATION_SELLERS: JSON.stringify([{ corridor: 'PE', secret: sellerMx.secret() }]) }))).toThrow(
            /corridor must be one of/,
        );
        expect(() =>
            loadConfig(
                env({
                    VALIDATION_SELLERS: JSON.stringify([
                        { corridor: 'MX', secret: sellerMx.secret() },
                        { corridor: 'MX', secret: sellerBr.secret() },
                    ]),
                }),
            ),
        ).toThrow(/twice/);
        expect(() => loadConfig(env({ VALIDATION_SELLERS: JSON.stringify([{ corridor: 'MX', secret: buyer.secret() }]) }))).toThrow(
            /different wallets/,
        );
    });

    it('validates amounts', () => {
        expect(() => loadConfig(env({ VALIDATION_AMOUNT_USDC: '0' }))).toThrow(/VALIDATION_AMOUNT_USDC/);
        // The API rejects order amounts without exactly two decimals
        expect(() => loadConfig(env({ VALIDATION_AMOUNT_USDC: '1' }))).toThrow(/exactly two decimals/);
        expect(() => loadConfig(env({ VALIDATION_AMOUNT_USDC: '1.5' }))).toThrow(/exactly two decimals/);
        expect(() => loadConfig(env({ VALIDATION_MIN_BALANCE_USDC: 'ten' }))).toThrow(/VALIDATION_MIN_BALANCE_USDC/);
    });

    it('needs at least 10.56, so the seller still nets the $10 BlindPay payout minimum after fees', () => {
        expect(() => loadConfig(env({ VALIDATION_AMOUNT_USDC: '10.00' }))).toThrow(/at least 10\.56/);
        expect(() => loadConfig(env({ VALIDATION_AMOUNT_USDC: '10.55' }))).toThrow(/at least 10\.56/);
        expect(loadConfig(env({ VALIDATION_AMOUNT_USDC: '10.56' })).amountUsdc).toBe('10.56');
    });

    it('needs read access to BlindPay to verify disbursements', () => {
        expect(loadConfig(env()).blindpay).toEqual({ baseUrl: 'https://api.blindpay.com/v1', instanceId: 'in_123', apiKey: 'bp_key' });
        expect(loadConfig(env({ VALIDATION_BLINDPAY_BASE_URL: 'https://bp.example/v1/' })).blindpay?.baseUrl).toBe('https://bp.example/v1');
        expect(() => loadConfig(env({ VALIDATION_BLINDPAY_API_KEY: undefined }))).toThrow(/VALIDATION_BLINDPAY_API_KEY/);
        expect(() => loadConfig(env({ VALIDATION_BLINDPAY_INSTANCE_ID: '' }))).toThrow(/VALIDATION_BLINDPAY_INSTANCE_ID/);
    });

    it('does not need BlindPay credentials for an escrow-only run', () => {
        const noBlindpay = env({ VALIDATION_BLINDPAY_INSTANCE_ID: undefined, VALIDATION_BLINDPAY_API_KEY: undefined });
        expect(() => loadConfig(noBlindpay)).toThrow(/VALIDATION_BLINDPAY_INSTANCE_ID/);
        expect(loadConfig(noBlindpay, { escrowOnly: true }).blindpay).toBeUndefined();
    });

    it('publishes only when a publish token is configured', () => {
        expect(loadConfig(env()).publishToken).toBeUndefined();
        expect(loadConfig(env({ VALIDATION_PUBLISH_TOKEN: ' tok ' })).publishToken).toBe('tok');
    });
});
