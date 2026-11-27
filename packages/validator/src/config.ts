import { Keypair, Networks } from '@stellar/stellar-sdk';

/**
 * Validation runner configuration, read from the environment.
 *
 * The runner drives a deployed OfferHub API exactly like a user would: it signs
 * in with dedicated test wallets, creates an order, signs every escrow step
 * locally (in place of Stellar Wallets Kit) and signs the seller's USDC
 * transfer to BlindPay. Real users and their orders are never touched.
 *
 * Secrets are only held in memory; nothing here is ever logged or reported.
 */

export const SUPPORTED_CORRIDORS = ['BR', 'MX', 'AR', 'CO'] as const;
export type Corridor = (typeof SUPPORTED_CORRIDORS)[number];

export interface SellerConfig {
    corridor: Corridor;
    /** Test wallet of an OfferHub user whose BlindPay KYC is approved and whose default bank account is in this corridor */
    keypair: Keypair;
}

export interface ValidationConfig {
    apiUrl: string;
    network: 'testnet' | 'mainnet';
    networkPassphrase: string;
    rpcUrl: string;
    usdcAssetCode: string;
    usdcIssuer: string;
    buyer: Keypair;
    sellers: SellerConfig[];
    amountUsdc: string;
    minBalanceUsdc: string;
    payoutTimeoutMs: number;
    pollIntervalMs: number;
    confirmTimeoutMs: number;
    confirmPollIntervalMs: number;
    /** Read access to the same BlindPay instance the API uses, to verify disbursements independently (#317) */
    /** Absent on an escrow-only run: the BlindPay leg is outside the scope it verifies */
    blindpay?: { baseUrl: string; instanceId: string; apiKey: string };
    /** Token for POST /validation/runs (#318); without it runs are not published */
    publishToken?: string;
}

const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const BLINDPAY_BASE_URL = 'https://api.blindpay.com/v1';
const USDC_ISSUER = {
    testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
} as const;

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new ConfigError(`${name} is required`);
    return value;
}

function keypairFrom(secret: string, label: string): Keypair {
    try {
        return Keypair.fromSecret(secret);
    } catch {
        // Never echo the value: it is a secret seed
        throw new ConfigError(`${label} is not a valid Stellar secret seed`);
    }
}

function usdcAmount(value: string, name: string): string {
    if (!/^\d+(\.\d{1,7})?$/.test(value) || Number(value) <= 0) {
        throw new ConfigError(`${name} must be a positive decimal amount (e.g. "10.00")`);
    }
    return value;
}

/**
 * Smallest order amount the API accepts (the API's MIN_ORDER_AMOUNT):
 * BlindPay pays out from $10, and the escrow fees (5.3%) come out first.
 */
const MIN_ORDER_AMOUNT = '10.56';

/**
 * The API only accepts order amounts with exactly two decimals, and at least
 * MIN_ORDER_AMOUNT (CreateOrderDto).
 */
function orderAmount(value: string, name: string): string {
    if (!/^\d+\.\d{2}$/.test(value)) {
        throw new ConfigError(`${name} must have exactly two decimals, as the API requires (e.g. "10.00")`);
    }
    if (Number(value) < Number(MIN_ORDER_AMOUNT)) {
        throw new ConfigError(
            `${name} must be at least ${MIN_ORDER_AMOUNT}, so the seller still receives the $10 BlindPay payout minimum after fees`,
        );
    }
    return usdcAmount(value, name);
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined || value.trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
    return n;
}

function parseSellers(raw: string): SellerConfig[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ConfigError('VALIDATION_SELLERS must be a JSON array');
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new ConfigError('VALIDATION_SELLERS must be a non-empty JSON array');
    }
    const seen = new Set<string>();
    return parsed.map((entry, i) => {
        if (typeof entry !== 'object' || entry === null) {
            throw new ConfigError(`VALIDATION_SELLERS[${i}] must be an object`);
        }
        const { corridor, secret } = entry as Record<string, unknown>;
        if (typeof corridor !== 'string' || !(SUPPORTED_CORRIDORS as readonly string[]).includes(corridor)) {
            throw new ConfigError(`VALIDATION_SELLERS[${i}].corridor must be one of ${SUPPORTED_CORRIDORS.join(', ')}`);
        }
        if (seen.has(corridor)) throw new ConfigError(`VALIDATION_SELLERS has corridor ${corridor} twice`);
        seen.add(corridor);
        if (typeof secret !== 'string') throw new ConfigError(`VALIDATION_SELLERS[${i}].secret is required`);
        return { corridor: corridor as Corridor, keypair: keypairFrom(secret, `VALIDATION_SELLERS[${i}].secret`) };
    });
}

export interface LoadConfigOptions {
    /** The run stops at the escrow release, so BlindPay credentials are not needed */
    escrowOnly?: boolean;
}

export function loadConfig(env: Env = process.env, options: LoadConfigOptions = {}): ValidationConfig {
    const network = (env.VALIDATION_NETWORK ?? 'mainnet').trim();
    if (network !== 'testnet' && network !== 'mainnet') {
        throw new ConfigError('VALIDATION_NETWORK must be "testnet" or "mainnet"');
    }

    const rpcUrl = env.VALIDATION_RPC_URL?.trim() || (network === 'testnet' ? TESTNET_RPC : '');
    if (!rpcUrl) {
        throw new ConfigError('VALIDATION_RPC_URL is required on mainnet (SDF runs no public mainnet RPC)');
    }

    const buyer = keypairFrom(required(env, 'VALIDATION_BUYER_SECRET'), 'VALIDATION_BUYER_SECRET');
    const sellers = parseSellers(required(env, 'VALIDATION_SELLERS'));
    if (sellers.some((s) => s.keypair.publicKey() === buyer.publicKey())) {
        throw new ConfigError('The buyer and a seller must be different wallets');
    }

    const amountUsdc = orderAmount(required(env, 'VALIDATION_AMOUNT_USDC'), 'VALIDATION_AMOUNT_USDC');
    const minBalanceUsdc = usdcAmount(required(env, 'VALIDATION_MIN_BALANCE_USDC'), 'VALIDATION_MIN_BALANCE_USDC');

    return {
        apiUrl: required(env, 'VALIDATION_API_URL').replace(/\/+$/, ''),
        network,
        networkPassphrase: network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
        rpcUrl,
        usdcAssetCode: env.VALIDATION_USDC_ASSET_CODE?.trim() || 'USDC',
        usdcIssuer: env.VALIDATION_USDC_ISSUER?.trim() || USDC_ISSUER[network],
        buyer,
        sellers,
        amountUsdc,
        minBalanceUsdc,
        payoutTimeoutMs: positiveInt(env.VALIDATION_PAYOUT_TIMEOUT_MS, 30 * 60_000, 'VALIDATION_PAYOUT_TIMEOUT_MS'),
        pollIntervalMs: positiveInt(env.VALIDATION_POLL_INTERVAL_MS, 10_000, 'VALIDATION_POLL_INTERVAL_MS'),
        confirmTimeoutMs: positiveInt(env.VALIDATION_CONFIRM_TIMEOUT_MS, 60_000, 'VALIDATION_CONFIRM_TIMEOUT_MS'),
        confirmPollIntervalMs: positiveInt(
            env.VALIDATION_CONFIRM_POLL_INTERVAL_MS,
            1_000,
            'VALIDATION_CONFIRM_POLL_INTERVAL_MS',
        ),
        blindpay: options.escrowOnly
            ? undefined
            : {
                  baseUrl: (env.VALIDATION_BLINDPAY_BASE_URL?.trim() || BLINDPAY_BASE_URL).replace(/\/+$/, ''),
                  instanceId: required(env, 'VALIDATION_BLINDPAY_INSTANCE_ID'),
                  apiKey: required(env, 'VALIDATION_BLINDPAY_API_KEY'),
              },
        publishToken: env.VALIDATION_PUBLISH_TOKEN?.trim() || undefined,
    };
}
