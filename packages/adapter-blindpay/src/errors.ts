/**
 * Error codes, messages and HTTP statuses the adapter's exceptions carry.
 * Plain strings and numbers, so an application can map them onto its own.
 */
export const BLINDPAY_ERROR_CODES = {
    PROVIDER_ERROR: 'PROVIDER_ERROR',
    PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
    PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
    PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
    STELLAR_NETWORK_ERROR: 'STELLAR_NETWORK_ERROR',
} as const;

export type BlindPayErrorCode = (typeof BLINDPAY_ERROR_CODES)[keyof typeof BLINDPAY_ERROR_CODES];

export const BLINDPAY_ERROR_MESSAGES: Record<BlindPayErrorCode, string> = {
    PROVIDER_ERROR: 'External provider error',
    PROVIDER_TIMEOUT: 'Timeout waiting for provider',
    PROVIDER_RATE_LIMITED: 'Provider rate limited',
    PROVIDER_UNAVAILABLE: 'Provider temporarily unavailable',
    STELLAR_NETWORK_ERROR: 'Stellar blockchain transaction failed',
};

export const BLINDPAY_ERROR_HTTP_STATUS: Record<BlindPayErrorCode, number> = {
    PROVIDER_ERROR: 502,
    PROVIDER_TIMEOUT: 504,
    PROVIDER_RATE_LIMITED: 502,
    PROVIDER_UNAVAILABLE: 503,
    STELLAR_NETWORK_ERROR: 502,
};
