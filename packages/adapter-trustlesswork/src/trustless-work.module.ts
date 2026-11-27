import { Module } from '@nestjs/common';
import { TrustlessWorkConfig } from './trustless-work.config';
import { EscrowClient } from './clients/escrow.client';
import { WalletClient } from './clients/wallet.client';
import { StellarRpcClient } from './clients/stellar-rpc.client';

/**
 * Nest module for the Trustless Work / Soroban escrow adapter.
 *
 * Provides the config (read from the environment), the Trustless Work REST
 * client, the wallet balance client and the Stellar RPC client. Import it into
 * any Nest application; it needs no database or other OfferHub module.
 */
@Module({
    providers: [TrustlessWorkConfig, EscrowClient, WalletClient, StellarRpcClient],
    exports: [TrustlessWorkConfig, EscrowClient, WalletClient, StellarRpcClient],
})
export class TrustlessWorkAdapterModule {}
