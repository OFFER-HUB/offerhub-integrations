/**
 * The RPC URL without its path, for logs: hosted providers (Chainstack) put
 * the access key in the path, and logs must not carry secrets.
 */
export function redactRpcUrl(url: string | undefined): string {
    if (!url) return 'not set';
    try {
        const parsed = new URL(url);
        return parsed.pathname && parsed.pathname !== '/' ? `${parsed.origin}/…` : parsed.origin;
    } catch {
        return '<invalid url>';
    }
}
