# @offerhub-orchestrator/adapter-blindpay

A NestJS adapter for [BlindPay](https://blindpay.com) USDC-to-fiat payouts. It is the integration OfferHub runs in production, extracted so any NestJS project can use it. It needs no database and nothing else from OfferHub.

MIT licensed.

## What it gives you

| Piece | What it does |
|-------|--------------|
| `BlindPayConfig` | Reads and validates the environment. Refuses a development instance on mainnet and a production instance on testnet. |
| `BlindPayService` | The BlindPay REST API: customers and KYC, bank accounts, quotes, payouts, payout lookup, webhook registration, and the development-only USDB trustline and mint. |
| `BlindPayAdapterModule` | A Nest module that provides and exports the two above. |
| Corridors | The four LATAM corridors BlindPay supports, their rails, currencies and the fields each rail requires. |
| `BlindPayProviderException` | What the client throws when BlindPay fails: a coded `HttpException` (`code`, `provider`, masked path). |

## Corridors

BlindPay pays out to bank accounts in **four** LATAM corridors. There is no rail for Peru, Chile or Costa Rica.

| Country | Rails | Currency | KYC tier |
|---------|-------|----------|----------|
| BR | `PIX`, `PIX_SAFE`, `TED` | BRL | standard |
| MX | `SPEI_BITSO` | MXN | standard |
| AR | `TRANSFERS_BITSO` | ARS | standard |
| CO | `ACH_COP_BITSO` | COP | enhanced |

`BLINDPAY_CORRIDORS`, `BLINDPAY_CORRIDOR_CURRENCY`, `BLINDPAY_RAIL_REQUIRED_DETAILS`, `BLINDPAY_RAIL_ACCOUNT_FIELD`, `isSupportedCorridor`, `isValidRailForCountry`, `requiresEnhancedKyc` and `missingRailDetails` are exported, so a form can validate a bank account before BlindPay sees it.

## Requirements

Node.js **20.19 or later**. The HTTP client (`ky`) is an ES module and the package loads it with `require`, which Node supports from 20.19; on Node 18 or 20.18 it fails with `ERR_REQUIRE_ESM`.

## Install

```bash
npm install @offerhub-orchestrator/adapter-blindpay
npm install @nestjs/common@^10 reflect-metadata
```

## Use

```ts
import { Module } from '@nestjs/common';
import { BlindPayAdapterModule } from '@offerhub-orchestrator/adapter-blindpay';

@Module({ imports: [BlindPayAdapterModule] })
export class AppModule {}
```

```ts
import { Inject, Injectable } from '@nestjs/common';
import { BlindPayService } from '@offerhub-orchestrator/adapter-blindpay';

@Injectable()
export class PayoutsService {
    constructor(@Inject(BlindPayService) private readonly blindPay: BlindPayService) {}

    async prepare(bankAccountId: string, senderWallet: string) {
        // Amounts are BlindPay minor units (cents)
        const quote = await this.blindPay.createQuote({ bankAccountId, requestAmount: 10000, currencyType: 'sender' });
        // The unsigned Stellar transaction the sender signs in their own wallet
        const { transaction_hash } = await this.blindPay.authorizeQuote({ quoteId: quote.id, senderWalletAddress: senderWallet });
        return { quoteId: quote.id, unsignedXdr: transaction_hash, expiresAt: quote.expires_at };
    }

    // After the sender signed it
    dispatch(quoteId: string, signedTransaction: string, senderWalletAddress: string) {
        return this.blindPay.createPayout({ quoteId, signedTransaction, senderWalletAddress });
    }

    status(payoutId: string) {
        return this.blindPay.getPayoutStatus(payoutId);
    }
}
```

The adapter never signs. The quote's USDC transfer is signed by the sender's wallet and sent back with `createPayout`.

A quote is only valid for a short time (30 seconds to 5 minutes): check `expires_at` before asking for a signature.

## API reference

`BlindPayService` (every method returns a promise; amounts are BlindPay minor units):

| Method | BlindPay call |
|--------|---------------|
| `createCustomer(params)` | Register a customer with their KYC data |
| `listCustomers()` / `getCustomer(id)` | Read customers |
| `generateTosUrl(redirectUrl)` | The terms-of-service page the customer must open and accept |
| `createBankAccount(customerId, params)` | Register a destination account for a rail |
| `createQuote({ bankAccountId, requestAmount, currencyType, coverFees?, network?, token? })` | Lock the rate and fees for a payout |
| `authorizeQuote({ quoteId, senderWalletAddress })` | The unsigned Stellar transaction the sender signs |
| `createPayout({ quoteId, signedTransaction, senderWalletAddress })` | Dispatch the signed transfer |
| `getPayoutStatus(id)` | Read one payout |
| `listPayouts(limit?, startingAfter?)` | A page of payouts, newest first |
| `findPayoutByQuoteId(quoteId, maxPages?)` | Find the payout a quote became, or `null` |
| `registerWebhook(url, events?)` | Subscribe a webhook endpoint |
| `createUsdbTrustline(address)` / `mintUsdb(address, amount, signedXdr)` | Development instances only: fund a test wallet with USDB |


## Configuration

| Variable | Required | Notes |
|----------|----------|-------|
| `BLINDPAY_API_KEY` | yes | |
| `BLINDPAY_INSTANCE_ID` | yes | Starts with `in_` |
| `BLINDPAY_BASE_URL` | yes | `https://` only, for example `https://api.blindpay.com/v1` |
| `BLINDPAY_WEBHOOK_SECRET` | yes | Starts with `whsec_` (Svix) |
| `BLINDPAY_ENV` | yes on mainnet | `development` (default) or `production`. Development settles in USDB, production in USDC |
| `STELLAR_NETWORK` | no | `testnet` (default) or `mainnet`; must match `BLINDPAY_ENV` |
| `APP_URL` | no | Used for the terms-of-service redirect |
| `BLINDPAY_TOS_REDIRECT_URL` | no | Overrides it |

## Errors

`BlindPayProviderException` carries a string `code` from `BLINDPAY_ERROR_CODES` (`PROVIDER_ERROR`, `PROVIDER_TIMEOUT`, `PROVIDER_RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `STELLAR_NETWORK_ERROR`) with a message and HTTP status. Only GET requests are retried: a POST that timed out may already have moved money, so it is never resent automatically.

## What is not in it

The payout orchestration (which bank account, retries, keeping a payout row) and webhook processing stay in OfferHub, because they write to its database. Webhooks are signed with Svix; verify them with the `svix` package and `BLINDPAY_WEBHOOK_SECRET`.

## Development

This package lives in the [offerhub-integrations](https://github.com/OFFER-HUB/offerhub-integrations) repository (`packages/adapter-blindpay`), and the version on npm is released from there by a GitHub Actions workflow, so npm shows its provenance. `npm test` at the repo root runs its tests, including one that fails if the package imports anything from another OfferHub package. The tests run with no environment variables and no network.
