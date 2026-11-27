import { HttpException, HttpStatus } from '@nestjs/common';
import {
    BLINDPAY_ERROR_CODES as ERROR_CODES,
    BLINDPAY_ERROR_HTTP_STATUS,
    BLINDPAY_ERROR_MESSAGES,
    type BlindPayErrorCode,
} from '../errors';

/**
 * Exception thrown when the BlindPay API returns an error or is unavailable.
 */
export class BlindPayProviderException extends HttpException {
    readonly code: string;
    readonly provider = 'BLINDPAY';

    constructor(
        message: string,
        method: string,
        path: string,
        statusCode: number = HttpStatus.BAD_GATEWAY,
    ) {
        // BlindPay's stellar payout endpoints can fail with a terse machine
        // code like "submit_transaction_failed" instead of a sentence —
        // usually because the signed transaction went stale (a newer quote
        // was already prepared for this payout). Echoing that verbatim reads
        // as gibberish to the seller, so it's given a real code/message here,
        // the same way EscrowClient already does for the escrow-release side
        // of a stale signature.
        const isStaleStellarSubmission = message === 'submit_transaction_failed';
        const errorCode = isStaleStellarSubmission
            ? ERROR_CODES.STELLAR_NETWORK_ERROR
            : BlindPayProviderException.mapStatusToErrorCode(statusCode);
        const errorMessage = isStaleStellarSubmission
            ? 'Stellar rejected this transfer. It may be stale because a newer transfer request was already ' +
              'prepared — please retry to sign a fresh one.'
            : message || BLINDPAY_ERROR_MESSAGES[errorCode];

        super(
            {
                error: {
                    code: errorCode,
                    message: errorMessage,
                    details: {
                        provider: 'BLINDPAY',
                        method: method.toUpperCase(),
                        path: BlindPayProviderException.maskPath(path),
                        originalStatus: statusCode,
                    },
                },
            },
            BLINDPAY_ERROR_HTTP_STATUS[errorCode] || HttpStatus.BAD_GATEWAY,
        );

        this.code = errorCode;
    }

    /**
     * Maps HTTP status codes from BlindPay to internal error codes.
     */
    private static mapStatusToErrorCode(statusCode: number): BlindPayErrorCode {
        if (statusCode === 429) {
            return ERROR_CODES.PROVIDER_RATE_LIMITED;
        }
        if (statusCode === 408 || statusCode === 504) {
            return ERROR_CODES.PROVIDER_TIMEOUT;
        }
        if (statusCode === 503) {
            return ERROR_CODES.PROVIDER_UNAVAILABLE;
        }
        return ERROR_CODES.PROVIDER_ERROR;
    }

    /**
     * Masks sensitive data in the request path for logging.
     */
    private static maskPath(path: string): string {
        return path.replace(/[a-zA-Z0-9_-]{20,}/g, '***');
    }
}
