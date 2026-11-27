# @offerhub/validator — Live Production Validation Framework

Runs OfferHub's full **escrow → fiat** cycle against a deployed API, reproducibly, and
reports every transaction it produced. It is the D3.3 deliverable of the T3 mainnet launch
(deliverable D3.3 of the SCF Build Tranche 3).

The runner is an **external client**: it talks to the public HTTP API through
[`@offerhub/sdk`](../sdk) exactly like the web app does, and signs locally where
the browser would use Stellar Wallets Kit. Nothing is mocked and no internal code path is
shortcut. A passing run means the deployed system works end to end.

## Scope

The validator verifies **OfferHub's own flow**: wallet sign-in, order creation, and the escrow
deployment, funding and release, with every transaction confirmed independently through Stellar
RPC. That is the part OfferHub builds and controls, so that is the part it re-runs on a schedule.

It does not re-run the bank leg. Paying out to a bank account depends on BlindPay and on the
banking rails of each country, which are outside OfferHub, and a repeatable run would need a real
bank account and KYC in every corridor. The bank leg is shown instead by real payouts made by
users from the app, each with its public BlindPay receipt (see the Tranche 3 completion report).

- **Default and scheduled runs:** `--escrow-only`. Steps 1 to 6 below. No BlindPay credentials and
  no seller KYC or bank account are needed.
- **Full cycle (optional):** steps 7 to 9 are still implemented. Run without `--escrow-only` with a
  seller whose BlindPay KYC and bank account are set up, and add `--min-corridors N` to require
  verified receipts in N corridors.

This scope is a modification of the original D3.3 wording, requested from the SCF team.

## What a run does

| # | Step | What happens | On-chain |
|---|------|--------------|----------|
| 1 | `preflight` | Reads the buyer's USDC balance over Stellar RPC; refuses to start below the floor or the run amount | — |
| 2 | `authenticate` | Buyer and seller sign in with their wallets (challenge + SEP-53 signature) | — |
| 3 | `create_order` | Buyer creates a one-milestone order for the seller, labelled `[validation]` | — |
| 4 | `escrow_create` | Buyer signs the TrustlessWork escrow deployment | 1 tx, confirmed |
| 5 | `escrow_fund` | Buyer signs the USDC funding | 1 tx, confirmed |
| 6 | `escrow_release` | Walks the release sequence (seller completes, buyer approves, buyer releases), each step signed by the party the API names | 3 tx, each confirmed |
| 7 | `payout_transfer` | Seller signs the USDC transfer to BlindPay's deposit address | 1 tx, confirmed |
| 8 | `payout_settlement` | Polls the OfferHub API until the payout is `COMPLETED` (fails on `FAILED` / `REFUNDED` / `ON_HOLD` or timeout) | — |
| 9 | `disbursement_verification` | Reads the same payout straight from BlindPay's API and builds the run's receipt | — |

### Independent on-chain confirmation

The runner doesn't take the API's word that a transaction landed. For every transaction it
submits (6 per run), it:

1. computes the transaction hash locally from the XDR it signed, and checks it matches the
   hash the API reports, which proves the API submitted the signed transaction unchanged;
2. polls Stellar RPC (`getTransaction`) right away until the transaction is in a closed
   ledger, and records the ledger, its close time, and how long confirmation took
   (`confirmedInMs`, measured from the API's response);
3. fails the step if the transaction failed on-chain or isn't found within
   `VALIDATION_CONFIRM_TIMEOUT_MS`. Transient RPC errors are retried until that deadline.

The release sequence confirms each transaction before asking the API for the next one.

### Disbursement receipts (BlindPay)

The OfferHub API marks a payout `COMPLETED` when BlindPay's `payout.complete` webhook (or the
orchestration status poll) says so. The runner then asks BlindPay directly, with its own
read-only key, and only accepts the disbursement when BlindPay's record:

- has status `completed` (still `processing` is polled until `VALIDATION_PAYOUT_TIMEOUT_MS`;
  anything else fails the step);
- is in the corridor's currency (BR → BRL, MX → MXN, AR → ARS, CO → COP);
- has a non-zero receiver amount.

The resulting `receipt` on the report holds the BlindPay payout id, the fiat amount (minor
units), the local rail that paid the bank account, its completion time, the Stellar
transaction BlindPay recorded for the USDC it received, and whether that is the seller
transfer the runner signed (`matchesPayoutTransfer`).

### Corridor coverage

SCF's bar for D3.3 is a verified disbursement in at least three corridors. With
`--min-corridors 3` the CLI fails unless at least three distinct corridors ended with a
passed run **and** a BlindPay receipt, and writes `coverage-<first run id>.json` next to the
run reports with each corridor's status and receipt.

The first failed step stops the run; the rest are reported as `skipped`. Every
money-moving call carries an idempotency key derived from the run id, so a retried
request is never applied twice.

One run covers one corridor. With several sellers configured, the CLI runs them one after
another (they share the buyer wallet).

## Test accounts

Each run uses dedicated, clearly labelled test wallets, never a real user's:

- **Buyer:** a Stellar account with a USDC trustline and enough USDC for the configured runs,
  plus XLM for fees.
- **One seller per corridor:** an OfferHub user (signed in with that wallet) whose BlindPay
  KYC is approved and whose default bank account is in that corridor: BR (PIX), MX (SPEI),
  AR (Transfers), CO (ACH). Provisioning is tracked in
  Provisioning them needs a BlindPay account and real bank accounts, which is why they are optional.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `VALIDATION_API_URL` | Yes | Base URL of the API, including `/api/v1` |
| `VALIDATION_NETWORK` | No | `mainnet` (default) or `testnet` |
| `VALIDATION_RPC_URL` | Mainnet | Stellar RPC endpoint (defaults to SDF's on testnet) |
| `VALIDATION_BUYER_SECRET` | Yes | Secret seed of the buyer test wallet |
| `VALIDATION_SELLERS` | Yes | JSON array: `[{"corridor":"MX","secret":"S..."}, ...]`, one seller per corridor |
| `VALIDATION_AMOUNT_USDC` | Yes | Amount per run, two decimals, at least `10.56` (the seller must still net BlindPay's $10 payout minimum after the 5.3% escrow fees); must clear the highest corridor minimum |
| `VALIDATION_MIN_BALANCE_USDC` | Yes | Buyer balance floor below which no run starts |
| `VALIDATION_USDC_ISSUER` | No | Defaults to Circle's USDC issuer for the network |
| `VALIDATION_PAYOUT_TIMEOUT_MS` | No | How long to wait for the fiat disbursement (default 30 min) |
| `VALIDATION_POLL_INTERVAL_MS` | No | Payout polling interval (default 10 s) |
| `VALIDATION_CONFIRM_TIMEOUT_MS` | No | How long a submitted transaction may take to appear on-chain (default 60 s) |
| `VALIDATION_CONFIRM_POLL_INTERVAL_MS` | No | RPC polling interval for confirmations (default 1 s) |
| `VALIDATION_BLINDPAY_INSTANCE_ID` | Full cycle only | The BlindPay instance the API pays out through |
| `VALIDATION_BLINDPAY_API_KEY` | Full cycle only | A BlindPay API key for that instance; the runner only reads payouts with it |
| `VALIDATION_BLINDPAY_BASE_URL` | No | Defaults to `https://api.blindpay.com/v1` |
| `VALIDATION_PUBLISH_TOKEN` | For publishing | Same value as the API's `VALIDATION_PUBLISH_TOKEN`; without it runs are not published |

Secret seeds, the BlindPay key and the publish token are only held in memory. They are never logged, and configuration errors
never echo them.

## Running it

```bash
# Every configured corridor
npm run validate

# One corridor, JSON report per run in ./validation-reports
npm run validate -- --corridor MX --out validation-reports

# Every corridor, failing unless at least 3 have a verified BlindPay receipt
npm run validate -- --min-corridors 3 --out validation-reports

# Check configuration and the buyer balance only, move no funds
npm run validate -- --preflight-only

# Escrow only (the scope the validator verifies): stop after the release, skip the BlindPay
# payout (steps 7-9). No BlindPay credentials, and the seller needs no KYC or bank account.
# The corridor is only a label, and without --corridor one run uses the first seller.
npm run validate -- --escrow-only
```

Exit code: `0` all runs passed (and coverage met), `1` a run failed, coverage is below
`--min-corridors`, or a report could not be published, `2` configuration error.

### In CI

`.github/workflows/validation.yml` in OfferHub's API repository runs the same
command on demand (**Actions → Production validation → Run workflow**, with optional
corridor, preflight-only and escrow-only inputs) and every Monday at 14:00 UTC. Scheduled runs
are escrow-only, and so is the on-demand default; turn `escrow_only` off for the full cycle, which
requires `--min-corridors 3`. It only runs when the
repository variable `VALIDATION_ENABLED` is `true`, never two at once, and uploads each
run's JSON report as an artifact.

## Report format

```json
{
  "id": "vr_6c543d02b4517d44",
  "network": "mainnet",
  "corridor": "MX",
  "trigger": "schedule",
  "status": "passed",
  "startedAt": "2026-11-16T14:00:03.120Z",
  "finishedAt": "2026-11-16T14:06:41.904Z",
  "durationMs": 398784,
  "orderId": "ord_…",
  "contractId": "C…",
  "receipt": {
    "corridor": "MX",
    "source": "blindpay",
    "blindpayPayoutId": "po_…",
    "status": "completed",
    "currency": "MXN",
    "receiverAmountMinor": 127400,
    "senderAmountMinor": 7500,
    "stellarTxHash": "158126dd…09d0",
    "matchesPayoutTransfer": true,
    "paymentProvider": "Nvio Pagos",
    "providerTransactionId": null,
    "completedAt": "2026-11-16T14:06:32.717Z",
    "verifiedAt": "2026-11-16T14:06:41.880Z"
  },
  "steps": [
    {
      "name": "escrow_fund",
      "status": "passed",
      "txHashes": ["dbe89356…37ff"],
      "confirmations": [
        { "hash": "dbe89356…37ff", "status": "SUCCESS", "ledger": 61203345, "ledgerClosedAt": "2026-11-16T14:01:12.000Z", "confirmedInMs": 1180, "polls": 2 }
      ],
      "durationMs": 9300,
      "details": { "orderStatus": "IN_PROGRESS" }
    }
  ]
}
```

## Publication

With `VALIDATION_PUBLISH_TOKEN` set, every finished run (not `--preflight-only`) is posted to
the API's `POST /validation/runs` right after it ends. The API rebuilds the report field by
field (unknown fields are rejected or dropped, the API URL is not stored), refuses runs from a
different network than its own, and stores it by run id, so re-publishing replaces it.

The public, unauthenticated `GET /validation/runs?limit=20` (optional `corridor`, `status`;
`limit` 1–100) is what offer-hub.org/stats reads:

```json
{
  "data": [{
    "id": "vr_…", "startedAt": "…", "finishedAt": "…", "network": "mainnet",
    "status": "passed", "corridor": "MX", "steps": [ /* StepResult[] */ ],
    "stellarExpertUrls": ["https://stellar.expert/explorer/public/tx/…"],
    "blindpayPayoutId": "po_…", "blindpayStatus": "completed",
    "trigger": "schedule", "durationMs": 398784, "orderId": "ord_…", "contractId": "C…",
    "stellarExpertContractUrl": "https://stellar.expert/explorer/public/contract/C…",
    "receipt": { /* DisbursementReceipt */ }, "publishedAt": "…"
  }],
  "meta": { "total": 12 }
}
```

`blindpayStatus` is `completed` only when the runner verified the disbursement with BlindPay
itself; BlindPay has no public receipt page, so `receipt` is the verifiable record.
