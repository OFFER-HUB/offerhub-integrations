/**
 * Error codes the clients attach to the errors they throw (`error.code`).
 * Callers can switch on them without importing anything else. The values are
 * plain strings, so an application can map them onto its own error codes.
 */
export const TRUSTLESS_ERROR_CODES = {
    PROVIDER_ERROR: 'PROVIDER_ERROR',
    PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
    PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
    ESCROW_NOT_FOUND: 'ESCROW_NOT_FOUND',
    ESCROW_ALREADY_FUNDED: 'ESCROW_ALREADY_FUNDED',
    ESCROW_INSUFFICIENT_FUNDS: 'ESCROW_INSUFFICIENT_FUNDS',
    STELLAR_NETWORK_ERROR: 'STELLAR_NETWORK_ERROR',
} as const;

export type TrustlessErrorCode = (typeof TRUSTLESS_ERROR_CODES)[keyof typeof TRUSTLESS_ERROR_CODES];
