import { BaseResource } from './base';
import type { KycProfile, SubmitKycRequest } from '../types';

/**
 * The signed-in seller's KYC for BlindPay. Requires a user session.
 *
 * Before a first payout the seller submits KYC and accepts BlindPay's terms
 * of service in their own browser (`tosUrl` → redirect → `acceptTos`).
 */
export class KycResource extends BaseResource {
    /** `NotFoundError` until a profile has been submitted. */
    async get(): Promise<KycProfile> {
        return this.http.request<KycProfile>('GET', 'users/me/kyc');
    }

    async submit(data: SubmitKycRequest): Promise<KycProfile> {
        return this.http.request<KycProfile>('POST', 'users/me/kyc', { body: data });
    }

    /**
     * One-time BlindPay URL where the user accepts the terms. BlindPay
     * redirects back to `redirectUrl` with `?tos_id=...` appended.
     */
    async tosUrl(redirectUrl?: string): Promise<string> {
        const { url } = await this.http.request<{ url: string }>('POST', 'users/me/kyc/tos-url', {
            body: redirectUrl ? { redirectUrl } : {},
        });
        return url;
    }

    /** Records the `tos_id` from BlindPay's redirect. */
    async acceptTos(tosId: string): Promise<KycProfile> {
        return this.http.request<KycProfile>('POST', 'users/me/kyc/tos-accept', { body: { tosId } });
    }
}
