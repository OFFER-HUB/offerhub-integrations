/**
 * Base error class for all OfferHub SDK errors.
 *
 * `code` is the API's own error code (e.g. `INSUFFICIENT_FUNDS`,
 * `PAYOUT_NO_BANK_ACCOUNT`) whenever the API sent one.
 */
export class OfferHubError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly statusCode: number,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = this.constructor.name;
    }
}

/** 401 — missing, invalid or expired credentials */
export class AuthenticationError extends OfferHubError {
    constructor(message: string, code = 'AUTHENTICATION_FAILED', details?: unknown) {
        super(message, code, 401, details);
    }
}

/** 403 — authenticated, but not allowed (wrong scope, not a party to the order…) */
export class AuthorizationError extends OfferHubError {
    constructor(message: string, code = 'AUTHORIZATION_FAILED', details?: unknown) {
        super(message, code, 403, details);
    }
}

/** 404 */
export class NotFoundError extends OfferHubError {
    constructor(message: string, code = 'RESOURCE_NOT_FOUND', details?: unknown) {
        super(message, code, 404, details);
    }
}

/** 400 — request body or params failed validation */
export class ValidationError extends OfferHubError {
    constructor(message: string, code = 'VALIDATION_ERROR', details?: unknown) {
        super(message, code, 400, details);
    }
}

/** 422 `INSUFFICIENT_FUNDS` */
export class InsufficientFundsError extends OfferHubError {
    constructor(message: string, details?: unknown) {
        super(message, 'INSUFFICIENT_FUNDS', 422, details);
    }
}

/** 409 — the resource is not in a state that allows the action */
export class ConflictError extends OfferHubError {
    constructor(message: string, code = 'CONFLICT', details?: unknown) {
        super(message, code, 409, details);
    }
}

/** 502/504 — Trustless Work, BlindPay or Stellar failed or timed out */
export class ProviderError extends OfferHubError {
    constructor(message: string, code: string, statusCode: number, details?: unknown) {
        super(message, code, statusCode, details);
    }
}

/** 429 */
export class RateLimitError extends OfferHubError {
    constructor(message: string, public readonly retryAfter?: number, details?: unknown) {
        super(message, 'RATE_LIMIT_EXCEEDED', 429, details);
    }
}

/** The request never got a response (DNS, connection reset, timeout) */
export class NetworkError extends OfferHubError {
    constructor(message: string, public readonly cause?: unknown) {
        super(message, 'NETWORK_ERROR', 0);
    }
}

interface ApiErrorBody {
    code?: string;
    message?: string | string[];
    details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Pulls `{ code, message, details }` out of an API error body.
 *
 * The API's filter sends `{ error: { code, message, details } }`; a few
 * framework-level errors still come through as Nest's `{ statusCode, message }`.
 */
function readErrorBody(body: unknown): ApiErrorBody {
    if (!isRecord(body)) return {};
    const inner = isRecord(body.error) ? body.error : body;
    return {
        code: typeof inner.code === 'string' ? inner.code : undefined,
        message:
            typeof inner.message === 'string' || Array.isArray(inner.message)
                ? (inner.message as string | string[])
                : undefined,
        details: inner.details,
    };
}

/**
 * Maps an HTTP error response to a typed SDK error.
 */
export function parseError(status: number, body: unknown, retryAfterHeader?: string | null): OfferHubError {
    const { code, message: rawMessage, details } = readErrorBody(body);
    const message = Array.isArray(rawMessage)
        ? rawMessage.join('; ')
        : rawMessage || `Request failed with status ${status}`;

    if (code === 'INSUFFICIENT_FUNDS') return new InsufficientFundsError(message, details);

    switch (status) {
        case 400:
            return new ValidationError(message, code, details);
        case 401:
            return new AuthenticationError(message, code, details);
        case 403:
            return new AuthorizationError(message, code, details);
        case 404:
            return new NotFoundError(message, code, details);
        case 409:
            return new ConflictError(message, code, details);
        case 429: {
            const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
            return new RateLimitError(message, Number.isFinite(retryAfter) ? retryAfter : undefined, details);
        }
        case 502:
        case 503:
        case 504:
            return new ProviderError(message, code ?? 'PROVIDER_ERROR', status, details);
        default:
            return new OfferHubError(message, code ?? 'UNKNOWN_ERROR', status, details);
    }
}
