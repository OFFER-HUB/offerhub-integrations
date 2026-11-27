import { Injectable, Inject, Logger } from '@nestjs/common';
import { redactRpcUrl } from '../redact-rpc-url';
import {
    Account,
    Address,
    Asset,
    FeeBumpTransaction,
    Keypair,
    Networks,
    SignerKey,
    StrKey,
    Transaction,
    nativeToScVal,
    rpc as StellarRpc,
    scValToNative,
    xdr,
} from '@stellar/stellar-sdk';
import { TrustlessWorkConfig } from '../trustless-work.config';
import { TRUSTLESS_ERROR_CODES as ERROR_CODES } from '../errors';

/** RPC caps a getEvents request at 5 filters × 5 topic patterns each. */
const MAX_FILTERS_PER_REQUEST = 5;
const MAX_TOPICS_PER_FILTER = 5;
/** Each recipient needs two patterns — one for `transfer`, one for `mint`. */
const RECIPIENTS_PER_REQUEST = Math.floor(
    (MAX_FILTERS_PER_REQUEST * MAX_TOPICS_PER_FILTER) / 2,
);
const EVENTS_PAGE_LIMIT = 1000;
/**
 * Ledgers per getEvents scan. Mainnet providers cap the work per request: on
 * Chainstack a 5,000-ledger USDC scan fails with -32001 "request exceeded
 * processing limit threshold" while 1,000 answers in a fraction of a second
 * (measured 2026-11-14). A window that still trips the limit is halved, down
 * to MIN_LEDGERS_PER_EVENTS_WINDOW.
 */
const LEDGERS_PER_EVENTS_WINDOW = 1000;
const MIN_LEDGERS_PER_EVENTS_WINDOW = 100;
const STROOPS_PER_UNIT = 10_000_000n;
/**
 * getTransaction attempts (1s apart) after sendTransaction accepts a
 * transaction. Covers the 30s timebounds every server-built transaction
 * carries, plus a few ledgers of slack.
 */
const SUBMISSION_POLL_ATTEMPTS = 40;

/**
 * A USDC credit into one of the requested accounts, decoded from the USDC
 * Stellar Asset Contract's `transfer`/`mint` events. Since Protocol 23
 * (CAP-67) a classic `payment` op emits these same events, so this is what
 * Horizon's payments stream used to report.
 */
export interface IncomingUsdcPayment {
    /** RPC event id — unique per event, unlike txHash */
    id: string;
    txHash: string;
    ledger: number;
    ledgerClosedAt: string;
    from: string;
    to: string;
    /** Decimal string with 7 places, same format Horizon used (e.g. "20.0000000") */
    amount: string;
}

/** Escrow flags as the TrustlessWork contract stores them. */
export interface EscrowFlags {
    disputed: boolean;
    released: boolean;
    resolved: boolean;
}

/**
 * A TrustlessWork escrow's state read straight from the ledger — the two
 * inputs `deriveEscrowStatusFromContract` needs.
 */
export interface OnChainEscrowState {
    flags: EscrowFlags;
    /** Balance of the escrow's trustline token held by the contract, in stroops */
    balance: bigint;
}

/** Native and asset balances of a classic account, in stroops (7 decimals). */
export interface AccountBalances {
    native: bigint;
    /** null when the account has no trustline to the asset */
    asset: bigint | null;
}

/** One signer on a classic account. The master key is listed like any other. */
export interface AccountSigner {
    /** G... for ed25519 keys, the StrKey encoding of the signer otherwise */
    key: string;
    weight: number;
}

/**
 * What the server needs to build and authorize a classic transaction for an
 * account: its current sequence (as an `Account` TransactionBuilder accepts)
 * and who can sign for it.
 */
export interface AccountState {
    account: Account;
    signers: AccountSigner[];
}

/**
 * The ledger rejected a transaction, or it never made it into one.
 *
 * `resultCodes` uses Horizon's spelling (`tx_bad_auth`, `op_low_reserve`, …)
 * so callers and API consumers keep the codes they already know. Only those
 * codes are kept — the envelope, which embeds signatures, never is.
 */
export class StellarTransactionFailedError extends Error {
    readonly code = ERROR_CODES.STELLAR_NETWORK_ERROR;

    constructor(
        readonly hash: string,
        readonly resultCodes: string[],
    ) {
        super(`Stellar transaction ${hash} failed: ${resultCodes.join(', ')}`);
        this.name = StellarTransactionFailedError.name;
    }
}

/**
 * Stellar RPC Client
 *
 * Thin wrapper around @stellar/stellar-sdk's `rpc.Server`, introduced
 * as part of the Horizon → Stellar RPC migration (D3.1). Deposit detection,
 * escrow sync, wallet balances, and classic transaction submission all go
 * through here — it is the platform's only gateway to the ledger. Horizon was
 * removed entirely (#310).
 */
@Injectable()
export class StellarRpcClient {
    private readonly logger = new Logger(StellarRpcClient.name);
    private server: StellarRpc.Server | null = null;
    private usdcContractId: string | null = null;

    constructor(@Inject(TrustlessWorkConfig) private readonly config: TrustlessWorkConfig) {}

    /**
     * Lazily construct the underlying RPC server. Deferred to first use (rather
     * than the constructor) so this client can be instantiated via DI even in
     * environments where STELLAR_RPC_URL isn't set yet (e.g. mainnet before a
     * provider is chosen) without breaking app startup.
     */
    private getServer(): StellarRpc.Server {
        if (!this.config.stellarRpcUrl) {
            throw new Error(
                'STELLAR_RPC_URL is not configured — required to use StellarRpcClient',
            );
        }
        if (!this.server) {
            this.server = new StellarRpc.Server(this.config.stellarRpcUrl);
            this.logger.log(
                `Initialized Stellar RPC client for ${this.config.stellarNetwork} network (${redactRpcUrl(this.config.stellarRpcUrl)})`,
            );
        }
        return this.server;
    }

    /**
     * Whether STELLAR_RPC_URL is set — callers that run in the background
     * check this up front instead of failing on every tick.
     */
    isConfigured(): boolean {
        return Boolean(this.config.stellarRpcUrl);
    }

    /**
     * Check RPC node health
     */
    async getHealth(): Promise<StellarRpc.Api.GetHealthResponse> {
        try {
            return await this.getServer().getHealth();
        } catch (error: unknown) {
            this.logger.error('Stellar RPC health check failed:', error);
            throw this.handleRpcError(error);
        }
    }

    /**
     * Fetch a transaction's status and result by hash
     * @param hash Transaction hash
     */
    async getTransaction(hash: string): Promise<StellarRpc.Api.GetTransactionResponse> {
        try {
            this.logger.debug(`Fetching transaction via RPC: ${hash}`);
            return await this.getServer().getTransaction(hash);
        } catch (error: unknown) {
            this.logger.error(`Failed to fetch transaction ${hash} via RPC:`, error);
            throw this.handleRpcError(error);
        }
    }

    /**
     * Whether a transaction landed and succeeded.
     *
     * Returns false for a failed transaction and for one RPC has no record
     * of — RPC keeps only its retention window of history (~7 days on SDF
     * nodes), so this is for verifying recent transactions, which is all
     * webhook verification needs.
     */
    async isTransactionSuccessful(hash: string): Promise<boolean> {
        const response = await this.getTransaction(hash);
        return response.status === StellarRpc.Api.GetTransactionStatus.SUCCESS;
    }

    /**
     * An account's sequence and signers, or null when it isn't on the ledger.
     */
    async getAccountState(address: string): Promise<AccountState | null> {
        try {
            const result = await this.getServer().getLedgerEntries(accountLedgerKey(address));
            const entry = result.entries[0];
            if (!entry) return null;

            const accountEntry = entry.val.account();
            return {
                account: new Account(address, accountEntry.seqNum().toString()),
                signers: readSigners(address, accountEntry),
            };
        } catch (error: unknown) {
            this.logger.error(`Failed to load account ${address} via RPC:`, error);
            throw this.handleRpcError(error);
        }
    }

    /**
     * An account's sequence as an `Account` for TransactionBuilder.
     * @throws when the account isn't on the ledger
     */
    async loadAccount(address: string): Promise<Account> {
        const state = await this.getAccountState(address);
        if (!state) {
            throw this.handleRpcError(new Error(`Account ${address} not found`));
        }
        return state.account;
    }

    /**
     * Native balance and `asset` trustline balance of a classic account, read
     * in a single getLedgerEntries call. Returns null when the account isn't
     * on the ledger.
     */
    async getAccountBalances(address: string, asset: Asset): Promise<AccountBalances | null> {
        try {
            const trustlineKey = xdr.LedgerKey.trustline(
                new xdr.LedgerKeyTrustLine({
                    accountId: Keypair.fromPublicKey(address).xdrAccountId(),
                    asset: asset.toTrustLineXDRObject(),
                }),
            );
            const result = await this.getServer().getLedgerEntries(
                accountLedgerKey(address),
                trustlineKey,
            );

            let native: bigint | null = null;
            let assetBalance: bigint | null = null;
            for (const entry of result.entries) {
                const kind = entry.val.switch();
                if (kind === xdr.LedgerEntryType.account()) {
                    native = BigInt(entry.val.account().balance().toString());
                } else if (kind === xdr.LedgerEntryType.trustline()) {
                    assetBalance = BigInt(entry.val.trustLine().balance().toString());
                }
            }

            if (native === null) return null;
            return { native, asset: assetBalance };
        } catch (error: unknown) {
            this.logger.error(`Failed to fetch balances for ${address} via RPC:`, error);
            throw this.handleRpcError(error);
        }
    }

    /**
     * Submit a signed transaction and wait for the ledger's verdict — the
     * synchronous behaviour Horizon's submitTransaction had. Returns the hash
     * once it succeeds.
     *
     * @throws {StellarTransactionFailedError} when the transaction is rejected
     *   on submission, fails in the ledger, or hasn't landed by the time
     *   polling gives up
     */
    async submitTransaction(transaction: Transaction | FeeBumpTransaction): Promise<string> {
        const server = this.getServer();
        const hash = transaction.hash().toString('hex');

        let sent: StellarRpc.Api.SendTransactionResponse;
        try {
            sent = await server.sendTransaction(transaction);
        } catch (error: unknown) {
            this.logger.error(`Failed to submit transaction ${hash} via RPC:`, error);
            throw this.handleRpcError(error);
        }

        if (sent.status === 'ERROR') {
            throw new StellarTransactionFailedError(
                hash,
                sent.errorResult ? describeTransactionResult(sent.errorResult) : ['submission_failed'],
            );
        }
        if (sent.status === 'TRY_AGAIN_LATER') {
            throw new StellarTransactionFailedError(hash, ['try_again_later']);
        }
        // PENDING, or DUPLICATE when this exact transaction was already sent —
        // either way the outcome is decided on the ledger.

        let final: StellarRpc.Api.GetTransactionResponse;
        try {
            final = await server.pollTransaction(hash, { attempts: SUBMISSION_POLL_ATTEMPTS });
        } catch (error: unknown) {
            this.logger.error(`Failed to poll transaction ${hash} via RPC:`, error);
            throw this.handleRpcError(error);
        }

        if (final.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
            return hash;
        }
        if (final.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
            throw new StellarTransactionFailedError(hash, describeTransactionResult(final.resultXdr));
        }
        throw new StellarTransactionFailedError(hash, ['submission_timeout']);
    }

    /**
     * Fetch contract/system events matching the given filters
     *
     * Note: RPC only retains ~7 days of event history (`startLedger` older
     * than that is rejected) — see docs/data skill for the historical-data
     * fallback (Hubble/Galexie) once callers actually depend on this.
     */
    async getEvents(
        request: StellarRpc.Api.GetEventsRequest,
    ): Promise<StellarRpc.Api.GetEventsResponse> {
        try {
            this.logger.debug(`Fetching events via RPC from ledger ${request.startLedger ?? 'cursor'}`);
            return await this.getServer().getEvents(request);
        } catch (error: unknown) {
            this.logger.error('Failed to fetch events via RPC:', error);
            throw this.handleRpcError(error);
        }
    }

    /**
     * Sequence of the latest ledger the RPC node has ingested
     */
    async getLatestLedgerSequence(): Promise<number> {
        try {
            return (await this.getServer().getLatestLedger()).sequence;
        } catch (error: unknown) {
            this.logger.error('Failed to fetch latest ledger via RPC:', error);
            throw this.handleRpcError(error);
        }
    }

    /**
     * Read a TrustlessWork escrow's flags and token balance from the ledger.
     *
     * The contract keeps its whole escrow struct in instance storage under the
     * `Escrow` key (verified on testnet), and holds its funds as a balance
     * entry in the trustline token's Stellar Asset Contract. Returns null when
     * the contract instance isn't on the ledger (wrong network, or archived).
     */
    async getEscrowState(contractId: string): Promise<OnChainEscrowState | null> {
        try {
            const server = this.getServer();
            const contract = new Address(contractId).toScAddress();
            const contractDataKey = (key: xdr.ScVal) =>
                xdr.LedgerKey.contractData(
                    new xdr.LedgerKeyContractData({ contract, key, durability: xdr.ContractDataDurability.persistent() }),
                );

            // TrustlessWork keeps the escrow struct as its own persistent entry under ["Escrow"]
            // (checked on testnet and mainnet contracts: their instance storage is empty). The
            // instance is read too, to tell "no such contract" apart, and as a fallback for a
            // contract version that keeps the struct in instance storage.
            const { entries } = await server.getLedgerEntries(
                contractDataKey(xdr.ScVal.scvLedgerKeyContractInstance()),
                contractDataKey(escrowStorageKey()),
            );
            const isInstance = (entry: (typeof entries)[number]) =>
                entry.val.contractData().key().switch() === xdr.ScValType.scvLedgerKeyContractInstance();
            const instanceEntry = entries.find(isInstance);
            const persistentEscrow = entries.find((entry) => !isInstance(entry) && isEscrowStorageKey(entry.val.contractData().key()));
            if (!instanceEntry && !persistentEscrow) return null;

            const escrowVal =
                persistentEscrow?.val.contractData().val() ??
                (instanceEntry?.val.contractData().val().instance().storage() ?? []).find((item) => isEscrowStorageKey(item.key()))?.val();
            if (!escrowVal) {
                throw new Error(`Contract ${contractId} has no Escrow entry in persistent or instance storage`);
            }
            const escrow = scValToNative(escrowVal) as unknown;

            const tokenContractId = readTrustlineContractId(escrow) ?? this.getUsdcContractId();
            const balanceKey = xdr.LedgerKey.contractData(
                new xdr.LedgerKeyContractData({
                    contract: new Address(tokenContractId).toScAddress(),
                    key: xdr.ScVal.scvVec([
                        xdr.ScVal.scvSymbol('Balance'),
                        new Address(contractId).toScVal(),
                    ]),
                    durability: xdr.ContractDataDurability.persistent(),
                }),
            );
            const balanceResult = await server.getLedgerEntries(balanceKey);
            const balanceEntry = balanceResult.entries[0];
            // No balance entry = the contract has never held the token.
            const balance = balanceEntry
                ? readSacBalance(scValToNative(balanceEntry.val.contractData().val()) as unknown)
                : 0n;

            return { flags: readEscrowFlags(escrow), balance };
        } catch (error: unknown) {
            this.logger.error(`Failed to read escrow ${contractId} via RPC:`, error);
            throw this.handleRpcError(error);
        }
    }

    /**
     * Incoming USDC credits to any of `recipients` in ledgers
     * [startLedger, endLedger), oldest first.
     *
     * Matches `transfer` events whose sender is a classic account (G...) and
     * `mint` events (a payment straight from the issuer). Transfers out of a
     * contract, claimable balance or liquidity pool are skipped — escrow
     * releases/refunds are contract → account transfers and are credited by
     * the escrow flow, not as deposits, which mirrors the old Horizon filter
     * on `type === 'payment'`.
     *
     * Recipients are filtered server-side by topic, batched to the RPC's
     * per-request filter limits.
     */
    async getIncomingUsdcPayments(
        recipients: string[],
        startLedger: number,
        endLedger: number,
    ): Promise<IncomingUsdcPayment[]> {
        const wanted = new Set(recipients);
        const payments: IncomingUsdcPayment[] = [];

        for (let i = 0; i < recipients.length; i += RECIPIENTS_PER_REQUEST) {
            const filters = this.buildIncomingUsdcFilters(
                recipients.slice(i, i + RECIPIENTS_PER_REQUEST),
            );
            const events = await this.getEventsInWindows(filters, startLedger, endLedger);
            for (const event of events) {
                const payment = this.toIncomingUsdcPayment(event);
                if (payment && wanted.has(payment.to)) {
                    payments.push(payment);
                }
            }
        }

        // Batches are each ordered, but interleave across batches.
        return payments.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    /**
     * All events matching `filters` in [startLedger, endLedger), scanned in
     * windows of LEDGERS_PER_EVENTS_WINDOW so no single request exceeds the
     * provider's processing limit. A window that still exceeds it is halved and
     * retried; below MIN_LEDGERS_PER_EVENTS_WINDOW the error is thrown.
     */
    private async getEventsInWindows(
        filters: StellarRpc.Api.EventFilter[],
        startLedger: number,
        endLedger: number,
    ): Promise<StellarRpc.Api.EventResponse[]> {
        const collected: StellarRpc.Api.EventResponse[] = [];
        let window = LEDGERS_PER_EVENTS_WINDOW;
        let from = startLedger;
        while (from < endLedger) {
            const to = Math.min(from + window, endLedger);
            try {
                collected.push(...(await this.getEventsInRange(filters, from, to)));
                from = to;
            } catch (error: unknown) {
                if (!isProcessingLimitError(error) || window <= MIN_LEDGERS_PER_EVENTS_WINDOW) {
                    throw error;
                }
                window = Math.max(MIN_LEDGERS_PER_EVENTS_WINDOW, Math.floor(window / 2));
                this.logger.warn(`getEvents hit the provider's processing limit; retrying with ${window}-ledger windows`);
            }
        }
        return collected;
    }

    /**
     * All events matching `filters` in [startLedger, endLedger), paging via
     * cursor.
     *
     * A short page does not mean the range is exhausted: RPC scans at most
     * ~10k ledgers per request and returns a cursor at the scan boundary,
     * possibly with zero events (verified on testnet — a 24h window is ~17k
     * ledgers). So paging continues until the cursor itself reaches
     * endLedger. Cursor mode can't carry an endLedger, so later pages are
     * trimmed to the range by hand.
     */
    private async getEventsInRange(
        filters: StellarRpc.Api.EventFilter[],
        startLedger: number,
        endLedger: number,
    ): Promise<StellarRpc.Api.EventResponse[]> {
        const collected: StellarRpc.Api.EventResponse[] = [];
        let page = await this.getEvents({ filters, startLedger, endLedger, limit: EVENTS_PAGE_LIMIT });

        for (;;) {
            const inRange = page.events.filter((event) => event.ledger < endLedger);
            collected.push(...inRange);
            if (inRange.length < page.events.length) {
                return collected; // Already past the end of the range.
            }

            const reached = cursorLedger(page.cursor);
            if (reached === null) {
                // Unrecognized cursor format — fall back to the page size.
                if (page.events.length < EVENTS_PAGE_LIMIT) return collected;
            } else if (reached >= endLedger - 1) {
                return collected;
            }

            const previousCursor = page.cursor;
            page = await this.getEvents({ filters, cursor: page.cursor, limit: EVENTS_PAGE_LIMIT });
            if (page.cursor === previousCursor && page.events.length === 0) {
                return collected; // No progress — the node has nothing further.
            }
        }
    }

    private buildIncomingUsdcFilters(recipients: string[]): StellarRpc.Api.EventFilter[] {
        const contractId = this.getUsdcContractId();
        const transfer = nativeToScVal('transfer', { type: 'symbol' }).toXDR('base64');
        const mint = nativeToScVal('mint', { type: 'symbol' }).toXDR('base64');

        // transfer: [symbol, from, to, asset]   mint: [symbol, to, asset]
        const topics = recipients.flatMap((recipient) => {
            const to = nativeToScVal(recipient, { type: 'address' }).toXDR('base64');
            return [
                [transfer, '*', to, '*'],
                [mint, to, '*'],
            ];
        });

        const filters: StellarRpc.Api.EventFilter[] = [];
        for (let i = 0; i < topics.length; i += MAX_TOPICS_PER_FILTER) {
            filters.push({
                type: 'contract',
                contractIds: [contractId],
                topics: topics.slice(i, i + MAX_TOPICS_PER_FILTER),
            });
        }
        return filters;
    }

    private toIncomingUsdcPayment(event: StellarRpc.Api.EventResponse): IncomingUsdcPayment | null {
        if (!event.inSuccessfulContractCall) return null;

        const [name, ...rest] = event.topic.map((topic) => scValToNative(topic) as unknown);
        let from: string;
        let to: string;
        if (name === 'transfer' && rest.length >= 2) {
            from = String(rest[0]);
            to = String(rest[1]);
            if (!StrKey.isValidEd25519PublicKey(from)) return null;
        } else if (name === 'mint' && rest.length >= 1) {
            from = this.config.stellarUsdcIssuer;
            to = String(rest[0]);
        } else {
            return null;
        }

        const stroops = this.readAmount(event.value);
        if (stroops === null || stroops <= 0n) return null;

        return {
            id: event.id,
            txHash: event.txHash,
            ledger: event.ledger,
            ledgerClosedAt: event.ledgerClosedAt,
            from,
            to,
            amount: formatStroops(stroops),
        };
    }

    /**
     * SAC transfer/mint data is a bare i128, or — when the destination is a
     * muxed account — a map `{ amount, to_muxed_id }` (CAP-67).
     */
    private readAmount(value: xdr.ScVal): bigint | null {
        const native = scValToNative(value) as unknown;
        if (typeof native === 'bigint') return native;
        if (native && typeof native === 'object' && 'amount' in native) {
            const amount = (native as { amount: unknown }).amount;
            if (typeof amount === 'bigint') return amount;
        }
        return null;
    }

    private getUsdcContractId(): string {
        if (!this.usdcContractId) {
            const passphrase = this.config.stellarNetwork === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
            this.usdcContractId = new Asset(
                this.config.stellarUsdcAssetCode,
                this.config.stellarUsdcIssuer,
            ).contractId(passphrase);
        }
        return this.usdcContractId;
    }

    /**
     * Handle Stellar RPC errors and map to internal error codes
     */
    private handleRpcError(error: unknown): Error {
        // JSON-RPC errors arrive as plain objects ({ code, message }), not Error instances
        const message =
            error instanceof Error
                ? error.message
                : typeof error === 'object' && error !== null && 'message' in error
                  ? String((error as { message: unknown }).message)
                  : String(error);
        const errorObj = new Error(`Stellar RPC error: ${message}`);
        (errorObj as Error & { code: string }).code = ERROR_CODES.STELLAR_NETWORK_ERROR;
        return errorObj;
    }
}

/** True for the provider's "too much work in one request" rejection (JSON-RPC -32001). */
function isProcessingLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('-32001') || message.toLowerCase().includes('processing limit');
}

function accountLedgerKey(address: string): xdr.LedgerKey {
    return xdr.LedgerKey.account(
        new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
    );
}

/**
 * The master key's weight lives in thresholds[0]; other signers are listed
 * separately. Horizon reported both in one list, and so does this.
 */
function readSigners(address: string, entry: xdr.AccountEntry): AccountSigner[] {
    const signers: AccountSigner[] = [{ key: address, weight: entry.thresholds()[0] }];
    for (const signer of entry.signers()) {
        signers.push({ key: SignerKey.encodeSignerKey(signer.key()), weight: signer.weight() });
    }
    return signers;
}

/** `txBadAuth` → `tx_bad_auth` */
function snakeCase(name: string): string {
    return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * A TransactionResult as Horizon's `extras.result_codes` spelled it: the
 * transaction code, then one code per operation when the transaction got as
 * far as applying them. Operation codes drop their operation-type prefix, the
 * way Horizon does (`setOptionsLowReserve` → `op_low_reserve`).
 */
function describeTransactionResult(result: xdr.TransactionResult): string[] {
    const outcome = result.result();
    const codes = [snakeCase(outcome.switch().name)];

    let operations: xdr.OperationResult[] = [];
    const kind = outcome.switch();
    if (
        kind === xdr.TransactionResultCode.txFeeBumpInnerSuccess() ||
        kind === xdr.TransactionResultCode.txFeeBumpInnerFailed()
    ) {
        const inner = outcome.innerResultPair().result().result();
        codes.push(snakeCase(inner.switch().name));
        if (
            inner.switch() === xdr.TransactionResultCode.txSuccess() ||
            inner.switch() === xdr.TransactionResultCode.txFailed()
        ) {
            operations = inner.results();
        }
    } else if (
        kind === xdr.TransactionResultCode.txSuccess() ||
        kind === xdr.TransactionResultCode.txFailed()
    ) {
        operations = outcome.results();
    }

    for (const operation of operations) {
        codes.push(describeOperationResult(operation));
    }
    return codes;
}

function describeOperationResult(operation: xdr.OperationResult): string {
    if (operation.switch() !== xdr.OperationResultCode.opInner()) {
        return snakeCase(operation.switch().name); // opBadAuth, opNoAccount, …
    }
    const tr = operation.tr();
    const type = tr.switch().name; // e.g. setOptions
    const name = (tr.value() as { switch(): { name: string } }).switch().name; // e.g. setOptionsLowReserve
    const suffix = name.startsWith(type) ? name.slice(type.length) : name;
    return `op${snakeCase(suffix.charAt(0).toUpperCase() + suffix.slice(1))}`;
}

/** The key TrustlessWork stores the escrow struct under: `["Escrow"]`. */
function escrowStorageKey(): xdr.ScVal {
    return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Escrow')]);
}

function isEscrowStorageKey(key: xdr.ScVal): boolean {
    const native = scValToNative(key) as unknown;
    return Array.isArray(native) && native.length === 1 && native[0] === 'Escrow';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFlags(value: unknown): EscrowFlags | null {
    if (!isRecord(value)) return null;
    return {
        disputed: value.disputed === true,
        released: value.released === true,
        resolved: value.resolved === true,
    };
}

/**
 * Single-release escrows carry top-level `flags`. Multi-release escrows keep
 * flags per milestone instead, so they're rolled up: released once every
 * milestone is released, disputed while any is, resolved once every
 * milestone is settled and at least one went through dispute resolution.
 */
function readEscrowFlags(escrow: unknown): EscrowFlags {
    if (!isRecord(escrow)) throw new Error('Escrow storage entry is not a struct');

    const topLevel = readFlags(escrow.flags);
    if (topLevel) return topLevel;

    const milestoneFlags = Array.isArray(escrow.milestones)
        ? escrow.milestones.map((milestone) => (isRecord(milestone) ? readFlags(milestone.flags) : null))
        : [];
    if (milestoneFlags.length === 0 || milestoneFlags.some((flags) => flags === null)) {
        throw new Error('Escrow storage entry has no recognizable flags');
    }
    const flags = milestoneFlags as EscrowFlags[];
    const settled = flags.every((f) => f.released || f.resolved);
    return {
        disputed: flags.some((f) => f.disputed),
        released: flags.every((f) => f.released),
        resolved: settled && flags.some((f) => f.resolved),
    };
}

function readTrustlineContractId(escrow: unknown): string | null {
    if (!isRecord(escrow) || !isRecord(escrow.trustline)) return null;
    const address = escrow.trustline.address;
    return typeof address === 'string' && StrKey.isValidContract(address) ? address : null;
}

/** SAC balance entries are `{ amount: i128, authorized, clawback }`. */
function readSacBalance(value: unknown): bigint {
    if (isRecord(value) && typeof value.amount === 'bigint') return value.amount;
    throw new Error('Unrecognized token balance entry');
}

/**
 * Ledger a getEvents cursor points at. Cursors are `<toid>-<event index>`,
 * where the TOID packs the ledger sequence into its upper 32 bits.
 */
function cursorLedger(cursor: string): number | null {
    const toid = cursor.split('-')[0];
    if (!/^\d+$/.test(toid)) return null;
    return Number(BigInt(toid) >> 32n);
}

/** Ledger stroops as a 7-decimal string, Horizon's balance format ("20.0000000"). */
export function formatStroops(stroops: bigint): string {
    const whole = stroops / STROOPS_PER_UNIT;
    const fraction = (stroops % STROOPS_PER_UNIT).toString().padStart(7, '0');
    return `${whole}.${fraction}`;
}
