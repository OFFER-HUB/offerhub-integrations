/**
 * OfferHub SDK
 * Official TypeScript SDK for the OfferHub Orchestrator API
 *
 * @packageDocumentation
 */

// Export main client
export { OfferHubSDK, type OfferHubSDKConfig } from './offerhub-sdk';

// Export types
export * from './types';

// Export errors
export * from './errors';

// Export HTTP client pieces for advanced use (custom credentials, injected fetch)
export {
    HttpClient,
    ApiKeyCredentials,
    BearerToken,
    newIdempotencyKey,
    SDK_VERSION,
    type HttpClientConfig,
    type Credentials,
    type FetchLike,
} from './client/http-client';
