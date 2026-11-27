import { Module } from '@nestjs/common';
import { BlindPayConfig } from './blindpay.config';
import { BlindPayService } from './services/blindpay.service';

/**
 * Nest module for the BlindPay adapter: the config (read from the environment)
 * and the REST client for customers and KYC, bank accounts, quotes and payouts.
 * It needs no database or other OfferHub module.
 */
@Module({
    providers: [BlindPayConfig, BlindPayService],
    exports: [BlindPayConfig, BlindPayService],
})
export class BlindPayAdapterModule {}
