/**
 * Types for the OfferHub SDK.
 *
 * Shapes mirror what the Orchestrator API returns after the SDK has unwrapped
 * its `{ data, meta }` envelope. Amounts are always decimal strings ("100.00").
 * Dates are ISO 8601 strings.
 */

// ==================== Common ====================

export interface CursorPage<T> {
    data: T[];
    hasMore: boolean;
    nextCursor?: string;
}

export interface CursorParams {
    limit?: number;
    cursor?: string;
}

/** Options accepted by every money-moving call. */
export interface IdempotentOptions {
    /**
     * Sent as the `Idempotency-Key` header. Generated automatically when
     * omitted; pass your own to make a retry from your side safe.
     */
    idempotencyKey?: string;
}

export type UserType = 'BUYER' | 'SELLER' | 'BOTH';

// ==================== Auth ====================

export interface RegisterRequest {
    email: string;
    password: string;
    username?: string;
    type?: UserType;
    /** Cloudflare Turnstile token; required when the API has captcha enabled. */
    captchaToken?: string;
}

export interface RegisteredUser {
    id: string;
    email: string;
    type: UserType;
}

export interface LoginRequest {
    email: string;
    password: string;
}

export interface WalletChallengeResponse {
    /** Nonce the wallet must sign */
    challenge: string;
    /** Seconds until the challenge expires */
    expiresIn: number;
}

export interface WalletVerifyRequest {
    /** Stellar public key (G...) */
    publicKey: string;
    /** Signature over `challenge`, produced by the wallet (Stellar Wallets Kit `signMessage`) */
    signature: string;
    challenge: string;
}

export interface SessionUser {
    id: string;
    email: string | null;
    username: string;
    firstName: string | null;
    lastName: string | null;
    type: UserType;
    balance?: { available: string; reserved: string } | null;
    wallet: { id: string; publicKey: string; type: WalletType } | null;
}

export interface Session {
    user: SessionUser;
    /** User JWT — pass it to `sdk.asUser(token)` */
    token: string;
}

export interface ApiKeyInfo {
    id: string;
    name: string;
    scopes: string[];
    lastUsedAt: string | null;
    createdAt: string;
}

export interface CreateApiKeyRequest {
    name: string;
    scopes: Array<'read' | 'write' | 'support'>;
}

export interface CreatedApiKey {
    id: string;
    name: string;
    scopes: string[];
    /** The full key — shown only once */
    key: string;
}

// ==================== Users (API key) ====================

export interface CreateUserRequest {
    /** Your own user ID — creating the same one twice returns the existing user */
    externalUserId: string;
    email?: string;
    type?: UserType;
}

export interface User {
    id: string;
    externalUserId: string;
    email: string | null;
    type: UserType;
    status: string;
    balance: { available: string; reserved: string; currency: string };
    createdAt: string;
    updatedAt: string;
}

// ==================== Balance (API key) ====================

export interface Balance {
    user_id: string;
    available: string;
    reserved: string;
    currency: string;
    total: string;
    updated_at: string;
}

export interface BalanceOperationRequest {
    amount: string;
    currency?: string;
    description?: string;
}

// ==================== Withdrawals (API key) ====================

export type WithdrawalStatus =
    | 'WITHDRAWAL_CREATED'
    | 'WITHDRAWAL_COMMITTED'
    | 'WITHDRAWAL_PENDING'
    | 'WITHDRAWAL_PENDING_USER_ACTION'
    | 'WITHDRAWAL_COMPLETED'
    | 'WITHDRAWAL_FAILED'
    | 'WITHDRAWAL_CANCELED';

export interface Withdrawal {
    id: string;
    userId: string;
    amount: string;
    currency: string;
    status: WithdrawalStatus;
    destinationType: string;
    destinationRef: string;
    createdAt: string;
    updatedAt: string;
}

export interface ListWithdrawalsParams extends CursorParams {
    userId: string;
}

// ==================== Orders ====================

export type OrderStatus =
    | 'ORDER_CREATED'
    | 'FUNDS_RESERVED'
    | 'ESCROW_CREATING'
    | 'ESCROW_FUNDING'
    | 'ESCROW_FUNDED'
    | 'IN_PROGRESS'
    | 'DELIVERED'
    | 'RELEASE_REQUESTED'
    | 'RELEASED'
    | 'REFUND_REQUESTED'
    | 'REFUNDED'
    | 'DISPUTED'
    | 'CLOSED';

export type MilestoneStatus = 'OPEN' | 'COMPLETED' | 'RELEASED';

export interface MilestoneInput {
    milestone_ref: string;
    title: string;
    amount: string;
}

export interface CreateOrderRequest {
    buyer_id: string;
    seller_id: string;
    amount: string;
    title: string;
    currency?: string;
    description?: string;
    client_order_ref?: string;
    /** Must add up to `amount` when given */
    milestones?: MilestoneInput[];
    metadata?: Record<string, unknown>;
}

export interface Milestone {
    id: string;
    orderId: string;
    milestoneRef: string;
    title: string;
    amount: string;
    status: MilestoneStatus;
    createdAt: string;
}

export type EscrowStatus =
    | 'CREATING'
    | 'CREATED'
    | 'FUNDING'
    | 'FUNDED'
    | 'RELEASING'
    | 'RELEASED'
    | 'REFUNDING'
    | 'REFUNDED'
    | 'DISPUTED';

export interface Escrow {
    id: string;
    orderId: string;
    trustlessContractId: string | null;
    status: EscrowStatus;
    amount: string;
    fundedAt: string | null;
    releasedAt: string | null;
    refundedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface Order {
    id: string;
    clientOrderRef: string | null;
    buyerId: string;
    sellerId: string;
    amount: string;
    currency: string;
    status: OrderStatus;
    title: string;
    description: string | null;
    metadata: Record<string, unknown> | null;
    escrow?: Escrow | null;
    milestones?: Milestone[];
    payout?: Payout | null;
    createdAt: string;
    updatedAt: string;
}

export interface ListOrdersParams extends CursorParams {
    buyer_id?: string;
    seller_id?: string;
    status?: OrderStatus;
}

// ==================== Client-side signing ====================

/** Single-shot escrow XDR (create or fund) for the user's own wallet to sign. */
export interface PreparedEscrowTransaction {
    orderId: string;
    operation: 'create' | 'fund';
    unsignedXdr: string;
    /** Unix ms after which the XDR is no longer valid */
    expiresAt: number;
}

export type EscrowStepName = 'complete_milestone' | 'approve_milestone' | 'release' | 'dispute';

/**
 * Next step of a multi-signature flow (release, refund, dispute).
 * `unsignedXdr` is null when there is nothing left to sign.
 */
export interface PreparedEscrowStep {
    orderId: string;
    operation: 'release' | 'refund' | 'dispute';
    step: EscrowStepName | null;
    /** Whose wallet has to sign this step */
    signer: 'buyer' | 'seller' | null;
    unsignedXdr: string | null;
    expiresAt: number | null;
}

export type EscrowSubmitOperation = 'create' | 'fund' | 'release' | 'refund' | 'dispute';

export interface SubmittedEscrowTransaction {
    transactionHash: string;
    order: Order;
}

// ==================== Resolution & Disputes ====================

export type DisputeReason = 'NOT_DELIVERED' | 'QUALITY_ISSUE' | 'OTHER';
export type DisputeStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED';
export type ResolutionDecision = 'FULL_RELEASE' | 'FULL_REFUND' | 'SPLIT';

export interface OpenDisputeRequest {
    openedBy: 'BUYER' | 'SELLER';
    reason: DisputeReason;
    description?: string;
    /** URLs of uploaded evidence */
    evidence?: string[];
}

export interface ResolveDisputeRequest {
    decision: ResolutionDecision;
    /** Seller's share, required for SPLIT */
    releaseAmount?: string;
    /** Buyer's share, required for SPLIT */
    refundAmount?: string;
    note?: string;
}

export interface Dispute {
    id: string;
    orderId: string;
    openedBy: 'BUYER' | 'SELLER';
    reason: DisputeReason;
    description: string | null;
    evidence: unknown;
    status: DisputeStatus;
    resolutionDecision: ResolutionDecision | null;
    decisionNote: string | null;
    order?: Order;
    createdAt: string;
    updatedAt: string;
}

export interface ListDisputesParams {
    orderId?: string;
    status?: DisputeStatus;
    openedBy?: 'BUYER' | 'SELLER';
    page?: number;
    limit?: number;
}

export interface DisputePage {
    data: Dispute[];
    hasMore: boolean;
}

// ==================== Wallet ====================

export type WalletType = 'INVISIBLE' | 'EXTERNAL';

export interface Wallet {
    id: string;
    type: WalletType;
    publicKey: string;
    isPrimary: boolean;
    isActive: boolean;
    createdAt: string;
}

export interface WalletSummary {
    availableBalance: string;
    reservedBalance: string;
    currency: string;
    pendingWithdrawals: { count: number; amount: string };
    stats: {
        earnings: { amount: string; previousAmount: string; changePercent: number };
        spending: { amount: string; previousAmount: string; changePercent: number };
    };
}

export interface WalletTransaction {
    id: string;
    type: 'credit' | 'debit' | 'reserve';
    amount: string;
    description: string;
    createdAt: string;
    orderId: string | null;
}

export interface WalletTransactionsParams {
    limit?: number;
    cursor?: string;
    type?: string;
}

export interface WalletTransactionsPage {
    data: WalletTransaction[];
    meta: { limit: number; count: number; nextCursor?: string | null };
}

export interface WalletClaimResult {
    /** The custodial key that no longer controls the account */
    custodialPublicKey: string;
    /** The user's key, now the account's signer */
    newSignerPublicKey: string;
    /** `set_options` transaction hash; null when the rotation was already on-chain */
    transactionHash: string | null;
    wallets: Wallet[];
}

export interface ConnectWalletRequest {
    publicKey: string;
    /** Signature over the challenge from `sdk.auth.walletChallenge` */
    signature: string;
    challenge?: string;
}

export interface ClaimWalletRequest {
    /** The user's own wallet, which becomes the signer of their custodial account */
    newSignerPublicKey: string;
    signature: string;
    challenge?: string;
}

// ==================== Payouts (BlindPay) ====================

export type PayoutStatus =
    | 'PENDING'
    | 'AWAITING_SIGNATURE'
    | 'PROCESSING'
    | 'COMPLETED'
    | 'FAILED'
    | 'ON_HOLD'
    | 'REFUNDED';

export interface Payout {
    id: string;
    userId: string;
    orderId: string;
    bankAccountId: string;
    blindpayPayoutId: string | null;
    corridor: string;
    status: PayoutStatus;
    usdcAmount: string;
    fiatAmount: string | null;
    fiatCurrency: string;
    exchangeRate: string | null;
    quoteExpiresAt: string | null;
    failureReason: string | null;
    createdAt: string;
    updatedAt: string;
}

/** Unsigned USDC transfer to BlindPay, for a non-custodial seller to sign. */
export interface PreparedPayoutTransfer {
    orderId: string;
    payoutId: string;
    /** Echo it back on submit — it detects a signature made against a replaced quote */
    quoteId: string;
    unsignedXdr: string;
    /** Unix ms after which the quote is no longer usable */
    expiresAt: number;
    senderWalletAddress: string;
    usdcAmount: string;
    fiatAmount: string | null;
}

export interface SubmitPayoutTransferRequest {
    signedXdr: string;
    quoteId: string;
}

// ==================== Bank accounts (BlindPay) ====================

/** Countries BlindPay can pay out to today. Peru, Chile and Costa Rica have no rail. */
export type PayoutCountry = 'BR' | 'MX' | 'AR' | 'CO';

export type BankAccountRail =
    | 'PIX'
    | 'PIX_SAFE'
    | 'TED'
    | 'SPEI_BITSO'
    | 'TRANSFERS_BITSO'
    | 'ACH_COP_BITSO';

export interface CreateBankAccountRequest {
    country: PayoutCountry;
    rail: BankAccountRail;
    accountNumber: string;
    bankName: string;
    holderName: string;
    isDefault?: boolean;
    /** Rail-specific fields, e.g. `{ spei_protocol: 'clabe' }` for SPEI */
    details?: Record<string, unknown>;
}

export interface BankAccount {
    id: string;
    userId: string;
    country: PayoutCountry;
    rail: BankAccountRail;
    accountNumber: string;
    bankName: string;
    holderName: string;
    isDefault: boolean;
    details: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
}

// ==================== KYC (BlindPay) ====================

export type KycIdDocType = 'PASSPORT' | 'ID_CARD' | 'DRIVERS';

export interface SubmitKycRequest {
    firstName: string;
    lastName: string;
    /** YYYY-MM-DD */
    dateOfBirth: string;
    country: string;
    taxId: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    stateProvinceRegion: string;
    postalCode: string;
    idDocCountry: string;
    idDocType: KycIdDocType;
    selfieFileUrl: string;
    idDocFrontFileUrl: string;
    idDocBackFileUrl?: string;
    /** Proof of address, source of funds and purpose are required for Colombia (enhanced KYC) */
    proofOfAddressDocType?: string;
    proofOfAddressDocFileUrl?: string;
    sourceOfFundsDocType?: string;
    sourceOfFundsDocFileUrl?: string;
    purposeOfTransactions?: string;
    purposeOfTransactionsExplanation?: string;
}

export interface KycProfile extends Omit<SubmitKycRequest, 'firstName' | 'lastName' | 'dateOfBirth'> {
    id: string;
    userId: string;
    kycTier: string;
    blindpayTosId: string | null;
    createdAt: string;
    updatedAt: string;
}
