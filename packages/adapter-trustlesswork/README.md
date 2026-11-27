# @offerhub-orchestrator/adapter-trustlesswork

A NestJS adapter for [Trustless Work](https://www.trustlesswork.com) Soroban escrows on Stellar. It is the integration OfferHub runs in production, extracted so any NestJS project can use it. It needs no database and nothing else from OfferHub.

MIT licensed.

## What it gives you

| Piece | What it does |
|-------|--------------|
| `TrustlessWorkConfig` | Reads and validates the environment (API key, network, RPC URL, USDC issuer). Refuses a testnet/mainnet mix-up at startup. |
| `EscrowClient` | The Trustless Work REST API: create, fund, release, dispute and resolve an escrow, milestone changes and approvals. Every write returns an **unsigned** XDR for the user's wallet to sign. |
| `StellarRpcClient` | Stellar RPC: transaction status, account and USDC balances, escrow contract state, events. No Horizon. |
| `WalletClient` | USDC balance and transaction verification on top of the RPC client. |
| `TrustlessWorkAdapterModule` | A Nest module that provides and exports the four above. |

It never signs for anyone. You sign in the user's wallet (for example with Stellar Wallets Kit) and send the signed XDR back with `EscrowClient.sendTransaction`.

## Requirements

Node.js 20 or later (the Stellar SDK requires it).

## Install

```bash
npm install @offerhub-orchestrator/adapter-trustlesswork
npm install @nestjs/common@^10 @stellar/stellar-sdk@^14 class-validator class-transformer reflect-metadata
```

The Stellar SDK is a peer dependency pinned to major 14: a newer major makes `npm install` fail until the adapter is updated for it. Stellar's own type declarations need `"skipLibCheck": true` in your `tsconfig.json` (the NestJS default) or `npm install -D @types/urijs`.

## Use

```ts
import { Module } from '@nestjs/common';
import { TrustlessWorkAdapterModule } from '@offerhub-orchestrator/adapter-trustlesswork';

@Module({ imports: [TrustlessWorkAdapterModule] })
export class AppModule {}
```

```ts
import { Inject, Injectable } from '@nestjs/common';
import { EscrowClient, StellarRpcClient } from '@offerhub-orchestrator/adapter-trustlesswork';

@Injectable()
export class CheckoutService {
    constructor(
        @Inject(EscrowClient) private readonly escrow: EscrowClient,
        @Inject(StellarRpcClient) private readonly rpc: StellarRpcClient,
    ) {}

    // 1. Ask Trustless Work for the deployment transaction, unsigned
    prepare(dto: CreateEscrowDto, platformAddress: string, disputeResolver: string) {
        return this.escrow.createEscrow(dto, platformAddress, disputeResolver);
    }

    // 2. After the user signed it in their wallet
    submit(signedXdr: string) {
        return this.escrow.sendTransaction(signedXdr);
    }

    // 3. Read the contract back from the ledger
    state(contractId: string) {
        return this.rpc.getEscrowState(contractId);
    }
}
```

## API reference

`EscrowClient` (Trustless Work REST; writes return an unsigned XDR):

| Method | What it does |
|--------|--------------|
| `createEscrow(dto, platformAddress, disputeResolver)` | Deploy a single-release escrow |
| `fundEscrow(contractId, amount, signer, escrowType?)` | Fund it |
| `getEscrow(contractId)` | Read it from Trustless Work |
| `changeMilestoneStatus(...)` / `completeMilestone(...)` | The seller marks the milestone done |
| `approveMilestone(...)` | The buyer approves it |
| `releaseEscrow(...)` / `releaseMilestoneFunds(...)` | Release the funds |
| `disputeEscrow(...)` | Open a dispute |
| `resolveDisputeForRefund(...)` / `resolveDisputeWithSplit(...)` | The dispute resolver settles it |
| `sendTransaction(signedXdr, maxRetries?)` | Submit a signed transaction |

`StellarRpcClient`: `getHealth()`, `getTransaction(hash)`, `isTransactionSuccessful(hash)`, `getAccountState(address)`, `getAccountBalances(address, asset)`, `submitTransaction(tx)`, `getEvents(...)`, `getLatestLedgerSequence()`, `getEscrowState(contractId)`, `getIncomingUsdcPayments(...)`.

`WalletClient`: `getWalletBalance(address)`, `accountExists(address)`, `verifyTransaction(hash)`.

## Configuration

| Variable | Required | Default |
|----------|----------|---------|
| `TRUSTLESS_API_KEY` | yes | Format `{id}.{secret}` |
| `TRUSTLESS_WEBHOOK_SECRET` | yes | Starts with `tw_whsec_` |
| `STELLAR_NETWORK` | no | `testnet` (or `mainnet`) |
| `TRUSTLESS_API_URL` | no | The Trustless Work API for the network |
| `STELLAR_RPC_URL` | no | A public Soroban RPC for the network |
| `STELLAR_USDC_ASSET_CODE` | no | `USDC` |
| `STELLAR_USDC_ISSUER` | no | Circle's issuer for the network |
| `TRUSTLESS_TIMEOUT_MS` | no | `60000` |

## Errors

The clients attach a string `code` to what they throw. `TRUSTLESS_ERROR_CODES` lists them: `PROVIDER_ERROR`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `ESCROW_NOT_FOUND`, `ESCROW_ALREADY_FUNDED`, `ESCROW_INSUFFICIENT_FUNDS`, `STELLAR_NETWORK_ERROR`.

## Types

`EscrowStatus`, `TrustlessEscrowContract`, `TrustlessWebhookEventType`, `mapTrustlessStatus` and `deriveEscrowStatusFromContract` are exported, along with the DTOs (`CreateEscrowDto`, `ReleaseDto`, `RefundDto`, `DisputeResolutionDto`, `TrustlessWebhookDto`).

## What is not in it

Webhook processing and balance projection stay in OfferHub, because they write to its database. The signature check for webhooks (`x-tw-signature`, HMAC-SHA256 of the body with `TRUSTLESS_WEBHOOK_SECRET`) is a few lines; see Trustless Work's docs.

## Development

This package lives in the [offerhub-integrations](https://github.com/OFFER-HUB/offerhub-integrations) repository (`packages/adapter-trustlesswork`), and the version on npm is released from there by a GitHub Actions workflow, so npm shows its provenance. `npm test` at the repo root runs its tests, including one that fails if the package imports anything from another OfferHub package. The tests run with no environment variables and no network.
