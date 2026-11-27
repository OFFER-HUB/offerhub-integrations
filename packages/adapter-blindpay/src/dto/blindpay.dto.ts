import type {
    BlindPayCurrencyType,
    BlindPayCustomerType,
    BlindPayKycType,
    BlindPayNetwork,
    BlindPayToken,
    BlindPayIdDocType,
    BlindPayProofOfAddressDocType,
    BlindPaySourceOfFundsDocType,
    BlindPayPurposeOfTransactions,
} from '../types';

/**
 * Params for POST /customers.
 *
 * Every field here was read off a live instance's validation errors while
 * building issue #249 — BlindPay's actual requirements turned out to be far
 * beyond the four fields (email/country/type/kyc_type) issue #220 verified
 * against a live instance a week earlier. Re-verify against a live instance
 * again before assuming this list is still complete; it has already changed
 * once.
 *
 * `tosId` comes from `BlindPayService.generateTosUrl` — the customer must
 * accept BlindPay's terms in their own browser first (server-side acceptance
 * is rejected), which redirects back with `tos_id` in the query string. See
 * issue #249.
 */
export interface CreateCustomerDto {
    email: string;
    /** ISO 3166-1 alpha-2. Decides the KYC tier via `requiresEnhancedKyc`. */
    country: string;
    type?: BlindPayCustomerType;
    kycType: BlindPayKycType;

    firstName: string;
    lastName: string;
    /** ISO 8601 datetime string, e.g. "1990-01-01T00:00:00.000Z" — a bare date ("1990-01-01") is rejected. */
    dateOfBirth: string;
    taxId: string;

    addressLine1: string;
    addressLine2?: string;
    city: string;
    stateProvinceRegion: string;
    postalCode: string;

    /** ISO 3166-1 alpha-2 — the document's issuing country, not necessarily the same as `country`. */
    idDocCountry: string;
    idDocType: BlindPayIdDocType;

    /** Public HTTPS URLs — BlindPay rejects data: URIs ("Only HTTP and HTTPS URLs are allowed"). */
    selfieFile: string;
    idDocFrontFile: string;
    idDocBackFile?: string;

    /** BlindPay's terms-of-service acceptance record for this customer. */
    tosId: string;

    // ── kycType: 'enhanced' only ──────────────────────────────────────────
    proofOfAddressDocType?: BlindPayProofOfAddressDocType;
    proofOfAddressDocFile?: string;
    sourceOfFundsDocType?: BlindPaySourceOfFundsDocType;
    sourceOfFundsDocFile?: string;
    purposeOfTransactions?: BlindPayPurposeOfTransactions;
    /** Required by BlindPay only when purposeOfTransactions is `other`. */
    purposeOfTransactionsExplanation?: string;
}

/**
 * Params for POST /quotes.
 *
 * `network` and `token` are optional: when omitted the service fills them from
 * configuration, so the T3 mainnet switch is a single env var change and no
 * caller hardcodes a network identifier.
 */
export interface CreateQuoteDto {
    /** BlindPay bank account id (their namespace, e.g. ba_6BcdN9ltKW9R). */
    bankAccountId: string;
    /** Minor units — 10000 is 100.00. */
    requestAmount: number;
    /** Whether requestAmount is the sender's stablecoin or the receiver's fiat. */
    currencyType: BlindPayCurrencyType;
    /** Whether the sender absorbs the fees. */
    coverFees?: boolean;
    network?: BlindPayNetwork;
    token?: BlindPayToken;
}

/**
 * Params for POST /payouts/stellar/authorize.
 *
 * BlindPay returns an unsigned transaction that the sender signs and submits to
 * the Stellar network before the payout can be created.
 */
export interface AuthorizeQuoteDto {
    quoteId: string;
    /** Stellar public key funding the payout. */
    senderWalletAddress: string;
}

/**
 * Params for POST /payouts/stellar.
 */
export interface CreatePayoutDto {
    quoteId: string;
    /** Signed transaction envelope, base64 XDR. */
    signedTransaction: string;
    senderWalletAddress: string;
}
