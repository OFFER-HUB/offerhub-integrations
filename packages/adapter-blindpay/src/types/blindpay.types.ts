/**
 * Networks BlindPay accepts on a quote. The list is theirs, not ours — it comes
 * back verbatim in the validation error when an unknown value is sent.
 */
export type BlindPayNetwork =
    | 'base'
    | 'sepolia'
    | 'arbitrum_sepolia'
    | 'base_sepolia'
    | 'arbitrum'
    | 'polygon'
    | 'polygon_amoy'
    | 'ethereum'
    | 'stellar'
    | 'stellar_testnet'
    | 'tron'
    | 'solana'
    | 'solana_devnet'
    | 'tempo'
    | 'tempo_testnet';

/** USDB is the test token on development instances; USDC/USDT are mainnet. */
export type BlindPayToken = 'USDC' | 'USDT' | 'USDB';

/**
 * Which side of the quote `request_amount` refers to: the stablecoin leaving
 * the sender, or the fiat reaching the receiver.
 */
export type BlindPayCurrencyType = 'sender' | 'receiver';

export type BlindPayPayoutStatus =
    | 'processing'
    | 'completed'
    | 'failed'
    | 'refunded'
    | 'on_hold';

/** Per-stage tracking BlindPay attaches to a payout. */
export interface BlindPayTrackingStep {
    step: string;
    status: string | null;
    transaction_hash: string | null;
    completed_at: string | null;
}

export interface BlindPayTrackingPayment {
    step: string;
    provider_name: string | null;
    provider_transaction_id: string | null;
    provider_status: string | null;
    estimated_time_of_arrival: string | null;
    completed_at: string | null;
}

/**
 * A payout quote. Locks the rate and the fee split; a payout can only execute
 * against a valid, unexpired quote.
 */
export interface BlindPayQuote {
    id: string;
    /** Epoch MILLISECONDS, not seconds. */
    expires_at: number;
    commercial_quotation: number;
    blindpay_quotation: number;
    /** Minor units of the stablecoin leaving the sender. */
    sender_amount: number;
    /** Minor units of the fiat reaching the receiver. */
    receiver_amount: number;
    partner_fee_amount: number | null;
    flat_fee: number | null;
    billing_fee_amount: number | null;
    /** ERC-20 approval payload; always null on Stellar. */
    contract: Record<string, unknown> | null;
}

/**
 * The unsigned Stellar transaction BlindPay hands back for the sender to sign.
 */
export interface BlindPayAuthorization {
    /**
     * The unsigned transaction envelope, base64 XDR.
     *
     * BlindPay calls the field `transaction_hash`, but it carries the whole
     * envelope to sign, not a hash — verified against a live instance.
     */
    transaction_hash: string;
}

export interface BlindPayPayout {
    id: string;
    status: BlindPayPayoutStatus;
    quote_id: string;
    instance_id: string;
    customer_id: string;
    bank_account_id: string;
    sender_wallet_address: string | null;
    network: BlindPayNetwork;
    token: BlindPayToken;
    /** Minor units. */
    sender_amount: number;
    receiver_amount: number;
    currency: string;
    commercial_quotation: number;
    blindpay_quotation: number;
    partner_fee_amount: number | null;
    transaction_fee_amount: number | null;
    tracking_transaction: BlindPayTrackingStep | null;
    tracking_payment: BlindPayTrackingPayment | null;
    tracking_complete: BlindPayTrackingStep | null;
    created_at: string;
    updated_at: string;
}

/** Who BlindPay pays: a payout's bank account hangs off a customer. */
export interface BlindPayCustomer {
    id: string;
    email: string;
    country: string;
    type: BlindPayCustomerType;
    kyc_status: string;
    kyc_type?: BlindPayKycType;
    /** The integrator's own id for this customer; empty for customers onboarded through BlindPay's hosted link */
    external_id?: string | null;
}

/**
 * A customer as `GET /customers/{id}` returns it: everything submitted for
 * KYC, used to link a customer onboarded outside OfferHub (#365). Only the
 * fields OfferHub stores are typed. The list endpoint omits `is_tos_accepted`.
 */
export interface BlindPayCustomerDetail extends BlindPayCustomer {
    is_tos_accepted?: boolean | null;
    tos_id?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    date_of_birth?: string | null;
    tax_id?: string | null;
    address_line_1?: string | null;
    address_line_2?: string | null;
    city?: string | null;
    state_province_region?: string | null;
    postal_code?: string | null;
    id_doc_country?: string | null;
    id_doc_type?: string | null;
    id_doc_front_file?: string | null;
    id_doc_back_file?: string | null;
    selfie_file?: string | null;
    proof_of_address_doc_type?: string | null;
    proof_of_address_doc_file?: string | null;
    source_of_funds_doc_type?: string | null;
    source_of_funds_doc_file?: string | null;
    purpose_of_transactions?: string | null;
    purpose_of_transactions_explanation?: string | null;
}

export type BlindPayCustomerType = 'individual' | 'business';

/**
 * `light` is undocumented/unused by this integration. Contrary to what this
 * comment used to say, development instances do **not** auto-approve KYC —
 * confirmed against a live instance while building issue #249: a standard
 * customer still needs full compliance data, and countries BlindPay
 * classifies as higher-risk (Colombia, of OfferHub's four corridors) need
 * `enhanced` specifically — `standard` is rejected outright for them
 * (`CUSTOMERS_ENHANCED_KYC_REQUIRED`). See `requiresEnhancedKyc` in
 * the OfferHub API for which corridors need which tier.
 */
export type BlindPayKycType = 'light' | 'standard' | 'enhanced';

/** A registered destination. The rail-specific fields differ per `type`. */
export interface BlindPayBankAccount {
    id: string;
    type: string;
    name: string;
}

export interface BlindPayWebhookEndpoint {
    id: string;
    url: string;
    events: string[];
    instance_id: string;
    created_at: string;
}

/** BlindPay's own validation envelope, returned with 4xx responses. */
export interface BlindPayErrorBody {
    success?: boolean;
    message?: string;
    errors?: Array<{ message?: string; path?: string[] }>;
}

export const HTTP_TIMEOUT_MS = 30_000;

/**
 * `POST /payouts/stellar` submits the signed transaction to Stellar before it
 * answers, and has taken longer than 30 s on mainnet. A longer wait, plus
 * retries under an Idempotency-Key, turns a slow answer into a real one instead
 * of an unknown outcome that someone has to check by hand.
 */
export const PAYOUT_SUBMIT_TIMEOUT_MS = 60_000;
export const PAYOUT_SUBMIT_MAX_ATTEMPTS = 3;
export const PAYOUT_SUBMIT_RETRY_DELAY_MS = 3_000;

export const DEFAULT_RETRY_OPTIONS = {
    maxRetries: 2,
    maxDelayMs: 5_000,
    // Only idempotent-by-nature failures. A payout POST that timed out may have
    // been accepted, so 5xx on POST is not retried blindly by ky's method list.
    retryStatusCodes: [408, 429, 500, 502, 503, 504],
} as const;

/** Document types BlindPay accepts for a customer's identity document. */
export type BlindPayIdDocType = 'PASSPORT' | 'ID_CARD' | 'DRIVERS';

export type BlindPayProofOfAddressDocType =
    | 'UTILITY_BILL'
    | 'BANK_STATEMENT'
    | 'RENTAL_AGREEMENT'
    | 'TAX_DOCUMENT'
    | 'GOVERNMENT_CORRESPONDENCE';

export type BlindPaySourceOfFundsDocType =
    | 'business_income'
    | 'gambling_proceeds'
    | 'gifts'
    | 'government_benefits'
    | 'inheritance'
    | 'investment_loans'
    | 'pension_retirement'
    | 'salary'
    | 'sale_of_assets_real_estate'
    | 'savings'
    | 'esops'
    | 'investment_proceeds'
    | 'someone_else_funds';

export type BlindPayPurposeOfTransactions =
    | 'business_transactions'
    | 'charitable_donations'
    | 'investment_purposes'
    | 'payments_to_friends_or_family_abroad'
    | 'personal_or_living_expenses'
    | 'protect_wealth'
    | 'purchase_good_and_services'
    | 'receive_payment_for_freelancing'
    | 'receive_salary'
    | 'other';
