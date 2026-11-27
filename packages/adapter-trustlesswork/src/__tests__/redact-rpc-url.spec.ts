import { redactRpcUrl } from '../redact-rpc-url';

describe('redactRpcUrl()', () => {
    it('drops the path, where hosted providers put the access key', () => {
        expect(redactRpcUrl('https://stellar-mainnet.core.chainstack.com/1aed9f21c1ce10b2')).toBe(
            'https://stellar-mainnet.core.chainstack.com/…',
        );
    });

    it('keeps a bare origin as is', () => {
        expect(redactRpcUrl('https://mainnet.sorobanrpc.com')).toBe('https://mainnet.sorobanrpc.com');
        expect(redactRpcUrl('https://soroban-testnet.stellar.org/')).toBe('https://soroban-testnet.stellar.org');
    });

    it('never echoes a value it cannot parse', () => {
        expect(redactRpcUrl(undefined)).toBe('not set');
        expect(redactRpcUrl('not a url with secret')).toBe('<invalid url>');
    });
});
