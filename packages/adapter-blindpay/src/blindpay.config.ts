import { Injectable, Logger } from '@nestjs/common';
import type { BlindPayNetwork, BlindPayToken } from './types';

/**
 * BlindPay instance environment.
 *
 * BlindPay does not separate environments by host — every request goes to the
 * same base URL. What decides the environment is the instance the API key
 * belongs to: a development instance settles on testnet networks with the USDB
 * test token, a production instance settles on mainnet with real USDC/USDT.
 */
export type BlindPayEnvironment = 'development' | 'production';

/**
 * BlindPay configuration
 * Validates required environment variables at startup
 */
@Injectable()
export class BlindPayConfig {
    private readonly logger = new Logger(BlindPayConfig.name);

    readonly environment: BlindPayEnvironment;
    readonly apiKey: string;
    readonly instanceId: string;
    readonly baseUrl: string;
    readonly webhookSecret: string;
    readonly stellarNetwork: 'testnet' | 'mainnet';
    readonly tosRedirectUrl: string;

    constructor() {
        this.apiKey = this.getRequiredEnv('BLINDPAY_API_KEY');
        this.instanceId = this.getRequiredEnv('BLINDPAY_INSTANCE_ID');
        // Trailing slashes would produce "//instances" once joined
        this.baseUrl = this.getRequiredEnv('BLINDPAY_BASE_URL').replace(/\/+$/, '');
        this.webhookSecret = this.getRequiredEnv('BLINDPAY_WEBHOOK_SECRET');
        // Where BlindPay sends the freelancer back after accepting the terms
        // of service, with `tos_id` appended — see BlindPayService.generateTosUrl
        // and issue #249. Same APP_URL fallback the email templates already use
        // (see EmailService), so a fresh checkout needs no extra config. Every
        // authenticated OFFER-HUB-Frontend page lives under /app/ (e.g.
        // /app/settings) — this is not an exception, despite the path repeating
        // "app".
        this.tosRedirectUrl = this.getEnv(
            'BLINDPAY_TOS_REDIRECT_URL',
            `${this.getEnv('APP_URL', 'http://localhost:3000')}/app/kyc/tos-callback`,
        );

        const environment = this.getEnv('BLINDPAY_ENV', 'development');
        if (environment !== 'development' && environment !== 'production') {
            throw new Error('BLINDPAY_ENV must be "development" or "production"');
        }
        this.environment = environment;

        const stellarNetwork = this.getEnv('STELLAR_NETWORK', 'testnet');
        if (stellarNetwork !== 'testnet' && stellarNetwork !== 'mainnet') {
            throw new Error('STELLAR_NETWORK must be "testnet" or "mainnet"');
        }
        this.stellarNetwork = stellarNetwork;

        this.validate();
    }

    /**
     * Base URL every BlindPay call hangs off.
     *
     * The instance id travels in the path — there is no Instance-Id header:
     *   POST {instanceUrl}/payouts/stellar
     */
    get instanceUrl(): string {
        return `${this.baseUrl}/instances/${this.instanceId}`;
    }

    /**
     * Value for the Authorization header on every BlindPay request.
     */
    get authorizationHeader(): string {
        return `Bearer ${this.apiKey}`;
    }

    /**
     * Network identifier BlindPay expects on a quote.
     *
     * Derived from STELLAR_NETWORK so no caller hardcodes it: the T3 mainnet
     * switch is one env var.
     */
    get network(): BlindPayNetwork {
        return this.stellarNetwork === 'mainnet' ? 'stellar' : 'stellar_testnet';
    }

    /**
     * Stablecoin BlindPay settles against. Development instances only accept the
     * USDB test token; production instances use real USDC.
     */
    get token(): BlindPayToken {
        return this.isProduction() ? 'USDC' : 'USDB';
    }

    /**
     * Check if pointing at a production instance (mainnet, real funds)
     */
    isProduction(): boolean {
        return this.environment === 'production';
    }

    /**
     * Check if pointing at a development instance (testnet, simulated payouts)
     */
    isDevelopment(): boolean {
        return this.environment === 'development';
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
        // Validate base URL (must be a valid https URI)
        let parsed: URL;
        try {
            parsed = new URL(this.baseUrl);
        } catch {
            throw new Error(
                `BLINDPAY_BASE_URL must be a valid URL - received "${this.baseUrl}"`,
            );
        }
        if (parsed.protocol !== 'https:') {
            throw new Error('BLINDPAY_BASE_URL must use https');
        }

        // A production instance pays out real funds. Pairing it with testnet
        // escrows would settle money for work that was never locked on mainnet.
        if (this.isProduction() && this.stellarNetwork !== 'mainnet') {
            throw new Error(
                'BLINDPAY_ENV=production requires STELLAR_NETWORK=mainnet - ' +
                'a production BlindPay instance pays out real funds',
            );
        }
        // The reverse is an incomplete mainnet config: a development instance
        // only settles on stellar_testnet with USDB, so every mainnet quote
        // would be rejected after the escrow had already released real USDC.
        if (this.isDevelopment() && this.stellarNetwork === 'mainnet') {
            throw new Error(
                'STELLAR_NETWORK=mainnet requires BLINDPAY_ENV=production - ' +
                'a development BlindPay instance only settles on stellar_testnet with USDB',
            );
        }

        // Format checks. A malformed value still reaches BlindPay, it just
        // fails there, so warn instead of blocking startup.
        if (!this.instanceId.startsWith('in_')) {
            this.logger.warn(
                'BLINDPAY_INSTANCE_ID does not start with "in_" - this may not be a valid instance id',
            );
        }
        if (!this.webhookSecret.startsWith('whsec_')) {
            this.logger.warn(
                'BLINDPAY_WEBHOOK_SECRET does not start with "whsec_" - Svix verification will reject every delivery',
            );
        }

        this.logger.log(`BlindPay configured: ${this.instanceUrl} (${this.environment})`);
    }
}
