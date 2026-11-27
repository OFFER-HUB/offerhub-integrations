import { rpc } from '@stellar/stellar-sdk';
import { formatStroops, RpcLedgerReader, toStroops } from '../ledger';

describe('RpcLedgerReader.getTransaction', () => {
    afterEach(() => jest.restoreAllMocks());

    it('normalises the ledger close time that RPC servers send as a string', async () => {
        jest.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({
            status: rpc.Api.GetTransactionStatus.SUCCESS,
            ledger: 5665312,
            createdAt: '1794350203',
        } as unknown as rpc.Api.GetTransactionResponse);

        const reader = new RpcLedgerReader('https://rpc.example.com', 'USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
        await expect(reader.getTransaction('ab'.repeat(32))).resolves.toEqual({
            status: 'SUCCESS',
            ledger: 5665312,
            closedAtUnix: 1794350203,
        });
    });

    it('maps a missing transaction to NOT_FOUND', async () => {
        jest.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValue({
            status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        } as unknown as rpc.Api.GetTransactionResponse);

        const reader = new RpcLedgerReader('https://rpc.example.com', 'USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
        await expect(reader.getTransaction('ab'.repeat(32))).resolves.toEqual({ status: 'NOT_FOUND' });
    });
});

describe('stroop helpers', () => {
    it('round-trips 7-decimal amounts without floating point', () => {
        expect(toStroops('10765.0523719')).toBe(107650523719n);
        expect(toStroops('5')).toBe(50000000n);
        expect(formatStroops(107650523719n)).toBe('10765.0523719');
    });
});
