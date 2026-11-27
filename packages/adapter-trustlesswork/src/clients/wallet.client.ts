import { Injectable, Inject, Logger } from '@nestjs/common';
import { Asset } from '@stellar/stellar-sdk';
import { TrustlessWorkConfig } from '../trustless-work.config';
import { StellarWalletBalance } from '../types/trustless-work.types';
import { StellarRpcClient } from './stellar-rpc.client';

/**
 * Ledger stroops (7 decimals) per unit of this codebase's on-chain amount
 * format, which carries 6 decimals.
 */
const LEDGER_STROOPS_PER_AMOUNT_UNIT = 10n;

/**
 * Stellar Wallet Client
 * Reads wallet balances and verifies transactions via Stellar RPC
 */
@Injectable()
export class WalletClient {
    private readonly logger = new Logger(WalletClient.name);
    private readonly usdcAsset: Asset;

    constructor(
        @Inject(TrustlessWorkConfig) private readonly config: TrustlessWorkConfig,
        @Inject(StellarRpcClient) private readonly rpc: StellarRpcClient,
    ) {
        this.usdcAsset = new Asset(config.stellarUsdcAssetCode, config.stellarUsdcIssuer);
        this.logger.log(
            `Initialized Stellar wallet client for ${config.stellarNetwork} network`,
        );
    }

    /**
     * Get wallet balance for a Stellar address
     * @param address Stellar public key (G...)
     * @returns Wallet balance with USDC and native XLM
     */
    async getWalletBalance(address: string): Promise<StellarWalletBalance> {
        this.logger.debug(`Fetching balance for address: ${address}`);

        const balances = await this.rpc.getAccountBalances(address, this.usdcAsset);
        if (!balances) {
            // Account not found - return zero balance
            this.logger.warn(`Account ${address} not found on Stellar network`);
            return {
                address,
                usdc_balance: '0',
                native_balance: '0',
            };
        }

        const usdcBalanceStroops = this.toAmountStroops(balances.asset ?? 0n);
        const nativeBalanceStroops = this.toAmountStroops(balances.native);

        this.logger.debug(
            `Balance for ${address}: ${usdcBalanceStroops} stroops USDC, ${nativeBalanceStroops} stroops XLM`,
        );

        return {
            address,
            usdc_balance: usdcBalanceStroops,
            native_balance: nativeBalanceStroops,
        };
    }

    /**
     * Check if a Stellar account exists
     */
    async accountExists(address: string): Promise<boolean> {
        return (await this.rpc.getAccountState(address)) !== null;
    }

    /**
     * Verify a transaction hash on Stellar
     */
    async verifyTransaction(transactionHash: string): Promise<boolean> {
        this.logger.debug(`Verifying transaction: ${transactionHash}`);
        return this.rpc.isTransactionSuccessful(transactionHash);
    }

    /**
     * Ledger stroops (7 decimals) to the 6-decimal integer format the rest of
     * the codebase calls stroops. Truncates, as the Horizon-era conversion did.
     */
    private toAmountStroops(ledgerStroops: bigint): string {
        return (ledgerStroops / LEDGER_STROOPS_PER_AMOUNT_UNIT).toString();
    }
}
