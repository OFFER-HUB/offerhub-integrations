/**
 * LATAM payout corridors supported through BlindPay.
 *
 * The rail names are BlindPay's own, so a value maps 1:1 onto the `type` field
 * of their bank-account API.
 *
 * BlindPay's full rail list also carries `wire`, `ach`, `rtp`,
 * `international_swift` and `sepa`; those are deliberately absent because
 * this adapter only covers LATAM payouts.
 *
 * There is **no rail for Peru, Chile or Costa Rica** on BlindPay today, so the
 * corridor count is four, not the seven originally assumed. @see issue #213
 */
export const BLINDPAY_CORRIDORS = {
    BR: ['PIX', 'PIX_SAFE', 'TED'],
    MX: ['SPEI_BITSO'],
    AR: ['TRANSFERS_BITSO'],
    CO: ['ACH_COP_BITSO'],
} as const;

/** ISO 3166-1 alpha-2 codes that can be paid out to. */
export type BlindPayCountry = keyof typeof BLINDPAY_CORRIDORS;

/** Every rail across every supported corridor. */
export type BlindPayRail = (typeof BLINDPAY_CORRIDORS)[BlindPayCountry][number];

export const BLINDPAY_COUNTRIES = Object.keys(BLINDPAY_CORRIDORS) as BlindPayCountry[];

/**
 * Corridors where BlindPay requires KYC_ENHANCED instead of KYC_STANDARD for
 * an individual customer — manual review on their side, up to 1 business day,
 * instead of instant approval. Verified against
 * https://www.blindpay.com/docs/kb/supported-countries, not assumed: of
 * the four corridors, only Colombia is classified this way today.
 *
 * @see issue #249
 */
export const BLINDPAY_ENHANCED_KYC_COUNTRIES: readonly BlindPayCountry[] = ['CO'];

/**
 * Whether a country needs BlindPay's enhanced KYC tier for an individual
 * customer, as opposed to standard.
 */
export function requiresEnhancedKyc(country: string): boolean {
    return (BLINDPAY_ENHANCED_KYC_COUNTRIES as readonly string[]).includes(country);
}

/**
 * Whether a country is one that can be paid out to.
 */
export function isSupportedCorridor(country: string): country is BlindPayCountry {
    return country in BLINDPAY_CORRIDORS;
}

/**
 * Whether a rail is one of the rails that country accepts.
 *
 * @example
 * isValidRailForCountry('MX', 'SPEI_BITSO') // true
 * isValidRailForCountry('MX', 'PIX')        // false
 */
export function isValidRailForCountry(country: string, rail: string): boolean {
    if (!isSupportedCorridor(country)) return false;
    return (BLINDPAY_CORRIDORS[country] as readonly string[]).includes(rail);
}

/**
 * Local currency each corridor settles in, ISO 4217.
 */
export const BLINDPAY_CORRIDOR_CURRENCY: Record<BlindPayCountry, string> = {
    BR: 'BRL',
    MX: 'MXN',
    AR: 'ARS',
    CO: 'COP',
};

/**
 * Rail-specific fields BlindPay requires when a bank account is registered,
 * beyond the ones every account carries.
 *
 * Read off their own validation errors on a live instance. The generic columns
 * cover the rest: `holderName` becomes `beneficiary_name`, and `accountNumber`
 * becomes whichever field that rail calls the account — `spei_clabe` for MX,
 * `transfers_account` for AR, `account_number` for the Brazilian bank rails.
 *
 * These are validated when the account is created, not when a payout runs, so a
 * freelancer finds out at the form rather than when their money is due.
 */
export const BLINDPAY_RAIL_REQUIRED_DETAILS: Record<BlindPayRail, readonly string[]> = {
    PIX: ['pix_key'],
    PIX_SAFE: ['account_type', 'pix_safe_bank_code', 'pix_safe_branch_code', 'pix_safe_cpf_cnpj'],
    TED: ['account_type', 'ted_bank_code', 'ted_branch_code', 'ted_cpf_cnpj'],
    SPEI_BITSO: ['spei_protocol'],
    TRANSFERS_BITSO: ['transfers_type'],
    // Confirmed against BlindPay's own bank-accounts skill doc (required
    // fields per type) — this was empty before because nobody had actually
    // registered a Colombian account yet; BlindPay's own error for a missing
    // one is just "internal_error", not a field-level validation message, so
    // this had gone unnoticed until a real ACH_COP_BITSO registration was
    // attempted.
    ACH_COP_BITSO: [
        'account_type',
        'ach_cop_beneficiary_first_name',
        'ach_cop_beneficiary_last_name',
        'ach_cop_document_type',
        'ach_cop_document_id',
        'ach_cop_email',
        'ach_cop_bank_code',
    ],
};

/**
 * Which BlindPay field carries the account number on a given rail.
 */
export const BLINDPAY_RAIL_ACCOUNT_FIELD: Record<BlindPayRail, string | null> = {
    PIX: null, // the pix_key is the destination; there is no account number
    PIX_SAFE: 'account_number',
    TED: 'account_number',
    SPEI_BITSO: 'spei_clabe',
    TRANSFERS_BITSO: 'transfers_account',
    ACH_COP_BITSO: 'ach_cop_bank_account',
};

/**
 * Returns the rail-specific keys missing from a bank account's details.
 *
 * @example
 * missingRailDetails('SPEI_BITSO', {}) // ['spei_protocol']
 */
export function missingRailDetails(
    rail: string,
    details: Record<string, unknown> | null | undefined,
): string[] {
    const required = BLINDPAY_RAIL_REQUIRED_DETAILS[rail as BlindPayRail];
    if (!required) return [];

    return required.filter((field) => {
        const value = details?.[field];
        return value === undefined || value === null || value === '';
    });
}
