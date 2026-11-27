# @offerhub/sdk

TypeScript client for the OFFER-HUB Orchestrator: USDC escrow on Stellar (Trustless Work), client-side signing with your users' own wallets, and payouts to local bank accounts through BlindPay.

- No runtime dependencies — uses the platform `fetch` (Node 18+, browsers, edge runtimes)
- Typed requests, responses and errors
- API keys exchanged for short-lived tokens automatically
- `Idempotency-Key` generated for every money-moving call

## Installation

```bash
npm install @offerhub/sdk
```

## Two kinds of credentials

The Orchestrator has two kinds of endpoints, and the SDK picks the right credentials for each:

| Credential | Where it lives | Resources |
|------------|---------------|-----------|
| **API key** (`ohk_live_...`) | Your marketplace backend | `users`, `balance`, `withdrawals`, `auth` (API keys) |
| **User session** (JWT) | Per signed-in user | `orders`, `escrow`, `resolution`, `disputes`, `wallet`, `payouts`, `bankAccounts`, `kyc` |

```typescript
import { OfferHubSDK } from '@offerhub/sdk';

// Backend client
const sdk = new OfferHubSDK({
  apiUrl: 'https://api.yourapp.com',
  apiKey: process.env.OFFERHUB_API_KEY, // needs `write` scope
});

// A user session — from email/password or a wallet signature
const session = await sdk.auth.login({ email: 'ana@example.com', password: '...' });
const ana = sdk.asUser(session.token);
```

The API key is never sent to business endpoints: the SDK trades it for a one-hour `ohk_tok_` token (`POST /auth/api-keys/:id/token`), caches it and re-mints it before it expires or after a 401.

## Wallet sign-in (Stellar Wallets Kit)

```typescript
const { challenge } = await sdk.auth.walletChallenge(publicKey);
const { signedMessage } = await kit.signMessage(challenge, { address: publicKey });
const session = await sdk.auth.walletVerify({ publicKey, challenge, signature: signedMessage });
const user = sdk.asUser(session.token);
```

## End-to-end flow

```typescript
// 1. Order + reserve (buyer)
const order = await buyer.orders.create({
  buyer_id: buyerId,
  seller_id: sellerId,
  amount: '100.00',
  title: 'Landing page',
  milestones: [
    { milestone_ref: 'design', title: 'Design', amount: '30.00' },
    { milestone_ref: 'build', title: 'Build', amount: '70.00' },
  ],
});
await buyer.orders.reserve(order.id);

// 2. Escrow, signed in the buyer's own wallet: deploy, then fund
const create = await buyer.escrow.prepareCreate(order.id);
await buyer.escrow.submit(order.id, 'create', await sign(create.unsignedXdr));

const fund = await buyer.escrow.prepareFund(order.id);
await buyer.escrow.submit(order.id, 'fund', await sign(fund.unsignedXdr));

// where sign = async (xdr) => (await kit.signTransaction(xdr, { networkPassphrase })).signedTxXdr

// 3. Seller delivers
await seller.orders.completeMilestone(order.id, 'design');

// 4. Release — several transactions, each signed by whoever the API asks for
let step = await buyer.resolution.prepareRelease(order.id);
while (step.unsignedXdr) {
  const client = step.signer === 'buyer' ? buyer : seller;
  const signed = await signInWalletOf(step.signer, step.unsignedXdr);
  await client.escrow.submit(order.id, 'release', signed);
  step = await client.resolution.prepareRelease(order.id);
}
```

Every step is signed by the user's own wallet: OfferHub never signs for a user. An admin's dispute decision is signed by the platform alone, once a party has signed the on-chain dispute (`prepareDispute`).

## Getting the seller paid (BlindPay)

On release the seller's USDC is converted to BRL, MXN, ARS or COP and paid into their bank account. The seller sets this up once:

```typescript
await seller.kyc.submit({ firstName: 'Luis', lastName: 'Pérez', country: 'MX', /* … */ });

const url = await seller.kyc.tosUrl('https://yourapp.com/kyc/tos-callback');
// redirect the seller to `url`; BlindPay sends them back with ?tos_id=...
await seller.kyc.acceptTos(tosIdFromQuery);

await seller.bankAccounts.create({
  country: 'MX',
  rail: 'SPEI_BITSO',
  accountNumber: '012180001234567891',
  bankName: 'BBVA México',
  holderName: 'Luis Pérez',
  isDefault: true,
  details: { spei_protocol: 'clabe' },
});
```

After the release, follow the payout. A seller with their own wallet signs the USDC transfer to BlindPay:

```typescript
const payout = await seller.payouts.get(order.id);

if (payout.status === 'AWAITING_SIGNATURE') {
  const transfer = await seller.payouts.prepare(order.id);
  const { signedTxXdr } = await kit.signTransaction(transfer.unsignedXdr, { networkPassphrase });
  await seller.payouts.submit(order.id, { signedXdr: signedTxXdr, quoteId: transfer.quoteId });
}

if (payout.status === 'FAILED') {
  // after fixing the bank account
  await seller.payouts.retry(order.id);
}
```

Corridors: Brazil (`PIX`, `PIX_SAFE`, `TED`), Mexico (`SPEI_BITSO`), Argentina (`TRANSFERS_BITSO`), Colombia (`ACH_COP_BITSO`).

## Disputes

```typescript
await buyer.resolution.openDispute(order.id, { openedBy: 'BUYER', reason: 'QUALITY_ISSUE', description: '…' });

// admin session
await admin.disputes.resolve(disputeId, {
  decision: 'SPLIT',
  releaseAmount: '60.00', // seller, paid out through BlindPay
  refundAmount: '40.00',  // buyer
});
```

## Backend operations (API key)

```typescript
const user = await sdk.users.create({ externalUserId: 'user_123', email: 'ana@example.com', type: 'SELLER' });
const balance = await sdk.balance.get(user.id);

// Withdrawal history (users move their own USDC from their own wallet)
const withdrawals = await sdk.withdrawals.list({ userId: user.id });
```

## Idempotency

Money-moving calls (`orders.create`, `escrow.submit`, `payouts.submit`) send an `Idempotency-Key`. One is generated per call; pass your own to make a retry from your side safe:

```typescript
await buyer.orders.create(data, { idempotencyKey: `order-${cartId}` });
```

## Errors

```typescript
import { InsufficientFundsError, ConflictError, NotFoundError, OfferHubError } from '@offerhub/sdk';

try {
  await buyer.orders.create(data);
} catch (error) {
  if (error instanceof InsufficientFundsError) { /* … */ }
  else if (error instanceof OfferHubError) {
    console.error(error.code, error.statusCode, error.message); // e.g. PAYOUT_NO_BANK_ACCOUNT 409
  }
}
```

| Class | HTTP |
|-------|------|
| `ValidationError` | 400 |
| `AuthenticationError` | 401 |
| `AuthorizationError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `InsufficientFundsError` | 422 `INSUFFICIENT_FUNDS` |
| `RateLimitError` | 429 |
| `ProviderError` | 502/503/504 |
| `NetworkError` | no response |

`error.code` is always the API's own code when it sent one.

## Configuration

```typescript
new OfferHubSDK({
  apiUrl: 'https://api.yourapp.com', // `/api/v1` is appended when missing
  apiKey: '...',                     // or accessToken: '...'
  timeout: 30000,                    // ms
  retryAttempts: 2,                  // GET only, on network errors, 429 and 5xx
  headers: { 'X-Request-Source': 'checkout' },
  fetch: customFetch,                // optional
});
```

## Upgrading from 2.x

3.0 removes every call that had the server sign for a user. Users sign each
transaction in their own wallet; the platform only signs its own dispute
resolution.

| 2.x | 3.0 |
|-----|-----|
| `escrow.create(orderId)`, `escrow.fund(orderId)` | `escrow.prepareCreate` / `prepareFund`, sign, `escrow.submit` |
| `resolution.release(orderId)` | Loop `resolution.prepareRelease` → sign → `escrow.submit(orderId, 'release', xdr)` |
| `resolution.refund(orderId, reason)` | Loop `resolution.prepareRefund` → sign → `escrow.submit(orderId, 'refund', xdr)` |
| `resolution.releaseMilestone(orderId, ref)` | Removed |
| `withdrawals.create(…)` | Removed: the user sends USDC from their own wallet. `withdrawals.list` / `get` remain |
| `openDispute` without an on-chain dispute | Sign `prepareDispute` first (buyer **or** seller); the admin's resolution needs the escrow disputed on-chain |

## Upgrading from 1.x

| 1.x | 2.0 |
|-----|-----|
| `sdk.topups.*` | Removed. Users deposit USDC to their Stellar address |
| `sdk.users.linkAirtm()` | Removed |
| `sdk.withdrawals.commit()`, `.refresh()` | Removed — withdrawals complete in one call |
| `withdrawals.create({ destinationType, … })` | `destinationType` is always `crypto` and set for you |
| `withdrawals.get(id)` | `withdrawals.get(id, userId)` |
| `sdk.withIdempotencyKey(key)` | Per call: `{ idempotencyKey }` (auto-generated by default) |
| `sdk.wallet.getInfo(userId)` | `user.wallet.summary()` / `user.wallet.list()` with a user session |
| `ky` dependency | None — native `fetch` |
| — | New: `auth`, `escrow`, `resolution`, `payouts`, `bankAccounts`, `kyc`, `sdk.asUser()` |

## License

MIT
