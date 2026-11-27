import { Injectable, Logger } from '@nestjs/common';
import { redactRpcUrl } from './redact-rpc-url';

export type StellarNetwork = 'testnet' | 'mainnet';

/**
 * Every value that changes between testnet and mainnet, in one place.
 *
 * Each one can still be overridden by its env var, but the default follows
 * STELLAR_NETWORK so the mainnet switch is one variable — and validate() refuses
 * an override that points at the other network.
 *
 * - `rpcUrl`: Stellar RPC has no SDF-hosted public mainnet endpoint (pick a
 *   provider from https://developers.stellar.org/docs/data/apis/rpc/providers),
 *   so mainnet has no default and STELLAR_RPC_URL is required there.
 * - `usdcIssuer`: Circle's USDC issuer on each network.
 * - `trustlessApiUrl`: TrustlessWork runs one API per network; the escrow
 *   contracts it deploys live on that network.
 */
export const STELLAR_NETWORK_DEFAULTS: Record<
    StellarNetwork,
    { rpcUrl: string; usdcIssuer: string; trustlessApiUrl: string }
> = {
    testnet: {
        rpcUrl: 'https://soroban-testnet.stellar.org',
        usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        trustlessApiUrl: 'https://dev.api.trustlesswork.com',
    },
    mainnet: {
        rpcUrl: '',
        usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        trustlessApiUrl: 'https://api.trustlesswork.com',
    },
};

/**
 * Trustless Work configuration
 * Validates required environment variables at startup
 */
@Injectable()
export class TrustlessWorkConfig {
    private readonly logger = new Logger(TrustlessWorkConfig.name);

    // Trustless Work API
    readonly apiKey: string;
    readonly apiUrl: string;
    readonly webhookSecret: string;
    readonly timeout: number;

    // Stellar Configuration
    readonly stellarNetwork: StellarNetwork;
    readonly stellarRpcUrl: string;
    readonly stellarUsdcAssetCode: string;
    readonly stellarUsdcIssuer: string;

    constructor() {
        // Trustless Work API
        this.apiKey = this.getRequiredEnv('TRUSTLESS_API_KEY');
        this.webhookSecret = this.getRequiredEnv('TRUSTLESS_WEBHOOK_SECRET');
        this.timeout = parseInt(this.getEnv('TRUSTLESS_TIMEOUT_MS', '60000'), 10);

        // Stellar Configuration
        const network = this.getEnv('STELLAR_NETWORK', 'testnet');
        if (network !== 'testnet' && network !== 'mainnet') {
            throw new Error('STELLAR_NETWORK must be "testnet" or "mainnet"');
        }
        this.stellarNetwork = network;
        const defaults = STELLAR_NETWORK_DEFAULTS[network];

        // Trailing slashes would produce "//deployer" once joined with a path
        this.apiUrl = this.getEnv('TRUSTLESS_API_URL', defaults.trustlessApiUrl).replace(/\/+$/, '');
        this.stellarRpcUrl = this.getEnv('STELLAR_RPC_URL', defaults.rpcUrl);
        this.stellarUsdcAssetCode = this.getEnv('STELLAR_USDC_ASSET_CODE', 'USDC');
        this.stellarUsdcIssuer = this.getEnv('STELLAR_USDC_ISSUER', defaults.usdcIssuer);

        this.validate();
    }

    private getEnv(key: string, defaultValue: string): string {
        return process.env[key] ?? defaultValue;
    }

    private getRequiredEnv(key: string): string {
        const value = process.env[key];
        if (!value) {
            throw new Error(`Missing required environment variable: ${key}`);
        }
        return value;
    }

    private validate(): void {
        // Validate API key format (format: {id}.{secret})
        if (!this.apiKey.includes('.') || this.apiKey.split('.').length !== 2) {
            this.logger.warn(
                'TRUSTLESS_API_KEY format may be invalid - expected format: {id}.{secret}',
            );
        }

        // Validate webhook secret format
        if (!this.webhookSecret.startsWith('tw_whsec_')) {
            this.logger.warn(
                'TRUSTLESS_WEBHOOK_SECRET does not start with "tw_whsec_" - this may not be a valid webhook secret',
            );
        }

        // Validate timeout
        if (this.timeout < 1000 || this.timeout > 120000) {
            throw new Error('TRUSTLESS_TIMEOUT_MS must be between 1000 and 120000');
        }

        // Validate Stellar RPC URL. It is the platform's only gateway to the
        // ledger (balances, submissions, deposits, escrow state), and mainnet
        // has no SDF-hosted default, so a missing value fails startup there.
        if (this.stellarRpcUrl && !/^https?:\/\//.test(this.stellarRpcUrl)) {
            throw new Error('STELLAR_RPC_URL must start with http:// or https://');
        }
        if (this.isMainnet() && !this.stellarRpcUrl) {
            throw new Error(
                'STELLAR_RPC_URL is required on mainnet. ' +
                    'Pick a provider from https://developers.stellar.org/docs/data/apis/rpc/providers',
            );
        }

        // Horizon was removed in D3.1 (#310). A leftover value is harmless but
        // misleading, so say so once instead of silently ignoring it.
        if (process.env.STELLAR_HORIZON_URL) {
            this.logger.warn('STELLAR_HORIZON_URL is no longer used (Horizon was removed) — remove it from the environment');
        }

        // Validate USDC issuer format (Stellar public key: G...)
        if (!this.stellarUsdcIssuer.startsWith('G') || this.stellarUsdcIssuer.length !== 56) {
            throw new Error(
                'STELLAR_USDC_ISSUER must be a valid Stellar public key (starts with G, 56 characters)',
            );
        }

        this.validateNetworkConsistency();

        this.logger.log(
            `TrustlessWork configured: ${this.apiUrl} (Stellar ${this.stellarNetwork}, ` +
                `RPC: ${redactRpcUrl(this.stellarRpcUrl)})`,
        );
    }

    /**
     * Refuse values left over from the other network.
     *
     * Switching STELLAR_NETWORK while an old .env still carries the testnet
     * issuer, RPC or TrustlessWork URL would start "on mainnet" and quietly keep
     * talking to testnet (or the reverse). Only values known to belong to a
     * network are checked; a custom RPC provider or a mock API URL passes.
     */
    private validateNetworkConsistency(): void {
        const other: StellarNetwork = this.isMainnet() ? 'testnet' : 'mainnet';
        const otherDefaults = STELLAR_NETWORK_DEFAULTS[other];

        if (this.stellarUsdcIssuer === otherDefaults.usdcIssuer) {
            throw new Error(
                `STELLAR_USDC_ISSUER is the ${other} USDC issuer but STELLAR_NETWORK=${this.stellarNetwork} - ` +
                    `use ${STELLAR_NETWORK_DEFAULTS[this.stellarNetwork].usdcIssuer} or unset it`,
            );
        }

        if (this.apiUrl === otherDefaults.trustlessApiUrl) {
            throw new Error(
                `TRUSTLESS_API_URL points at the ${other} TrustlessWork API but STELLAR_NETWORK=${this.stellarNetwork} - ` +
                    `use ${STELLAR_NETWORK_DEFAULTS[this.stellarNetwork].trustlessApiUrl} or unset it`,
            );
        }

        if (this.isMainnet() && /testnet|futurenet/i.test(this.stellarRpcUrl)) {
            throw new Error(
                `STELLAR_RPC_URL looks like a test network endpoint (${this.stellarRpcUrl}) but STELLAR_NETWORK=mainnet`,
            );
        }
    }

    /**
     * Check if running on Stellar mainnet (production)
     */
    isMainnet(): boolean {
        return this.stellarNetwork === 'mainnet';
    }

    /**
     * Check if running on Stellar testnet (development)
     */
    isTestnet(): boolean {
        return this.stellarNetwork === 'testnet';
    }
}
