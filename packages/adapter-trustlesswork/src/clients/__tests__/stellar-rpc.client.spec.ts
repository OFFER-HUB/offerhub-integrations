/**
 * Unit tests for StellarRpcClient — the thin RPC wrapper added by D3.1 issue
 * #306 alongside the existing Horizon-based WalletClient. Covers the wrapper
 * itself: server construction, the wrapped methods, and error mapping. The
 * USDC payment query is covered in stellar-rpc-usdc-payments.spec.ts against
 * the real SDK's XDR encoding.
 */
import { TRUSTLESS_ERROR_CODES as ERROR_CODES } from '../../errors';
import { StellarRpcClient } from '../stellar-rpc.client';

const mockGetHealth = jest.fn();
const mockGetTransaction = jest.fn();
const mockGetEvents = jest.fn();
const mockServerCtor = jest.fn().mockImplementation(() => ({
    getHealth: mockGetHealth,
    getTransaction: mockGetTransaction,
    getEvents: mockGetEvents,
}));

jest.mock('@stellar/stellar-sdk', () => ({
    rpc: {
        Server: jest.fn().mockImplementation((...args) => mockServerCtor(...args)),
    },
}));

function buildClient(overrides: Partial<{ stellarRpcUrl: string; stellarNetwork: string }> = {}) {
    const config = {
        stellarRpcUrl: 'https://soroban-testnet.stellar.org',
        stellarNetwork: 'testnet',
        ...overrides,
    };
    return new StellarRpcClient(config as never);
}

describe('StellarRpcClient', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('server construction', () => {
        it('does not construct the RPC server in the constructor', () => {
            buildClient();
            expect(mockServerCtor).not.toHaveBeenCalled();
        });

        it('lazily constructs the RPC server on first use, with the configured URL', async () => {
            mockGetHealth.mockResolvedValueOnce({ status: 'healthy' });
            const client = buildClient({ stellarRpcUrl: 'https://custom-rpc.example.org' });

            await client.getHealth();

            expect(mockServerCtor).toHaveBeenCalledTimes(1);
            expect(mockServerCtor).toHaveBeenCalledWith('https://custom-rpc.example.org');
        });

        it('reuses the same server instance across calls', async () => {
            mockGetHealth.mockResolvedValue({ status: 'healthy' });
            const client = buildClient();

            await client.getHealth();
            await client.getHealth();

            expect(mockServerCtor).toHaveBeenCalledTimes(1);
        });

        it('throws a clear error when STELLAR_RPC_URL is not configured', async () => {
            const client = buildClient({ stellarRpcUrl: '' });

            await expect(client.getHealth()).rejects.toThrow(/STELLAR_RPC_URL is not configured/);
            expect(mockServerCtor).not.toHaveBeenCalled();
        });
    });

    describe('getHealth', () => {
        it('returns the health response from the RPC server', async () => {
            mockGetHealth.mockResolvedValueOnce({ status: 'healthy' });
            const client = buildClient();

            const result = await client.getHealth();

            expect(result).toEqual({ status: 'healthy' });
            expect(mockGetHealth).toHaveBeenCalledTimes(1);
        });

        it('maps RPC failures to STELLAR_NETWORK_ERROR', async () => {
            mockGetHealth.mockRejectedValueOnce(new Error('connection refused'));
            const client = buildClient();

            await expect(client.getHealth()).rejects.toMatchObject({
                message: expect.stringContaining('connection refused'),
                code: ERROR_CODES.STELLAR_NETWORK_ERROR,
            });
        });
    });

    describe('getTransaction', () => {
        it('returns the transaction response from the RPC server', async () => {
            mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS', ledger: 12345 });
            const client = buildClient();

            const result = await client.getTransaction('tx_abc123');

            expect(result).toEqual({ status: 'SUCCESS', ledger: 12345 });
            expect(mockGetTransaction).toHaveBeenCalledWith('tx_abc123');
        });

        it('maps RPC failures to STELLAR_NETWORK_ERROR', async () => {
            mockGetTransaction.mockRejectedValueOnce(new Error('not found'));
            const client = buildClient();

            await expect(client.getTransaction('tx_missing')).rejects.toMatchObject({
                code: ERROR_CODES.STELLAR_NETWORK_ERROR,
            });
        });
    });

    describe('getEvents', () => {
        it('forwards the request and returns the events response', async () => {
            const request = { startLedger: 1000000, filters: [] } as never;
            mockGetEvents.mockResolvedValueOnce({ events: [], latestLedger: 1000010 });
            const client = buildClient();

            const result = await client.getEvents(request);

            expect(result).toEqual({ events: [], latestLedger: 1000010 });
            expect(mockGetEvents).toHaveBeenCalledWith(request);
        });

        it('maps RPC failures to STELLAR_NETWORK_ERROR', async () => {
            mockGetEvents.mockRejectedValueOnce(new Error('startLedger too old'));
            const client = buildClient();

            await expect(client.getEvents({ startLedger: 1 } as never)).rejects.toMatchObject({
                code: ERROR_CODES.STELLAR_NETWORK_ERROR,
            });
        });
    });
});
