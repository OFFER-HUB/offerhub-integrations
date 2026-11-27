/**
 * Unit tests for WalletClient on top of StellarRpcClient (#308). The RPC
 * client is faked; what matters here is the conversion from ledger stroops
 * (7 decimals) to the 6-decimal integer amounts BalanceProjectionService
 * reads, and the not-found handling Horizon's 404 used to drive.
 */
import { WalletClient } from '../wallet.client';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ADDRESS = 'GCKFBEIYTKP5RDBQMTVVALONAOPBXICILMAFQGODMHCM5EBMQ2GDJ5Q4';

function buildClient() {
    const rpc = {
        getAccountBalances: jest.fn(),
        getAccountState: jest.fn(),
        isTransactionSuccessful: jest.fn(),
    };
    const config = {
        stellarNetwork: 'testnet',
        stellarUsdcAssetCode: 'USDC',
        stellarUsdcIssuer: ISSUER,
    };
    return { client: new WalletClient(config as never, rpc as never), rpc };
}

describe('WalletClient', () => {
    describe('getWalletBalance', () => {
        it('converts ledger stroops to 6-decimal integer amounts, truncating', async () => {
            const { client, rpc } = buildClient();
            rpc.getAccountBalances.mockResolvedValueOnce({
                native: 50_000_009n, // 5.0000009 XLM
                asset: 1_234_567_891n, // 123.4567891 USDC
            });

            const balance = await client.getWalletBalance(ADDRESS);

            expect(balance).toEqual({
                address: ADDRESS,
                usdc_balance: '123456789',
                native_balance: '5000000',
            });
        });

        it('reads a missing USDC trustline as zero', async () => {
            const { client, rpc } = buildClient();
            rpc.getAccountBalances.mockResolvedValueOnce({ native: 10_000_000n, asset: null });

            expect((await client.getWalletBalance(ADDRESS)).usdc_balance).toBe('0');
        });

        it('returns a zero balance for an account not on the ledger', async () => {
            const { client, rpc } = buildClient();
            rpc.getAccountBalances.mockResolvedValueOnce(null);

            expect(await client.getWalletBalance(ADDRESS)).toEqual({
                address: ADDRESS,
                usdc_balance: '0',
                native_balance: '0',
            });
        });

        it('propagates RPC failures', async () => {
            const { client, rpc } = buildClient();
            rpc.getAccountBalances.mockRejectedValueOnce(new Error('Stellar RPC error: timeout'));

            await expect(client.getWalletBalance(ADDRESS)).rejects.toThrow('timeout');
        });
    });

    describe('accountExists', () => {
        it('is true only when the account is on the ledger', async () => {
            const { client, rpc } = buildClient();
            rpc.getAccountState.mockResolvedValueOnce({ account: {}, signers: [] });
            rpc.getAccountState.mockResolvedValueOnce(null);

            expect(await client.accountExists(ADDRESS)).toBe(true);
            expect(await client.accountExists(ADDRESS)).toBe(false);
        });
    });

    describe('verifyTransaction', () => {
        it('delegates to the RPC client', async () => {
            const { client, rpc } = buildClient();
            rpc.isTransactionSuccessful.mockResolvedValueOnce(true);

            expect(await client.verifyTransaction('abc')).toBe(true);
            expect(rpc.isTransactionSuccessful).toHaveBeenCalledWith('abc');
        });
    });
});
