# offerhub-integrations

The open-source packages behind [OfferHub](https://www.offer-hub.org), a non-custodial freelance
marketplace on Stellar. Clients lock USDC in a Soroban escrow ([Trustless Work](https://www.trustlesswork.com)),
freelancers deliver, and [BlindPay](https://blindpay.com) settles the USDC to a local bank account.
OfferHub never holds user funds.

These are the same modules OfferHub runs in production. They are MIT licensed, and each npm release
is built from this repository by GitHub Actions, so the package page on npm shows its provenance.

| Package | What it is | npm |
|---------|------------|-----|
| [`@offerhub-orchestrator/adapter-trustlesswork`](packages/adapter-trustlesswork) | NestJS module: Trustless Work escrow client, Stellar RPC client and wallet balances | [npm](https://www.npmjs.com/package/@offerhub-orchestrator/adapter-trustlesswork) |
| [`@offerhub-orchestrator/adapter-blindpay`](packages/adapter-blindpay) | NestJS module: BlindPay customers and KYC, bank accounts, quotes and payouts, and the table of supported LATAM corridors | [npm](https://www.npmjs.com/package/@offerhub-orchestrator/adapter-blindpay) |
| [`@offerhub/validator`](packages/validator) | The live production validation runner: drives a deployed OfferHub API like a user would and confirms every transaction through Stellar RPC | source only |
| [`@offerhub/sdk`](packages/sdk) | TypeScript client for OfferHub's HTTP API, used by the validator | source only |

Client-side escrow signing with Stellar Wallets Kit (`@offerhub-orchestrator/stellar-escrow-signing`)
lives in the [OfferHub frontend repository](https://github.com/OFFER-HUB/OFFER-HUB-Frontend).

The OfferHub backend itself is private: it handles wallet logic, encrypted key material and provider
credentials. Everything in this repository stands on its own and does not need it.

## Develop

```bash
npm ci
npm run build   # every package
npm test        # unit tests, no network and no secrets needed
npm run check:blank-project   # installs both adapters from packed tarballs into a blank NestJS project
```

Node 20.19 or newer. The adapters' tests also run in CI with no environment variables and the network
blocked, to keep the packages free of hidden dependencies on OfferHub.

## Releasing an adapter

Bump the version in the package's `package.json`, then push a tag that matches it:

```bash
git tag adapter-blindpay-v0.1.4 && git push origin adapter-blindpay-v0.1.4
```

The `Release` workflow builds the package, runs its tests with no environment and no network, checks
the tarball and publishes through npm Trusted Publishing. No npm token is stored anywhere.

## License

[MIT](LICENSE)
