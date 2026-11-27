import { HttpBlindPayReader, BlindPayReadError } from '../blindpay';

describe('HttpBlindPayReader', () => {
    it('reads the payout from the instance-scoped endpoint with the bearer key', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'po_1', status: 'completed' }) }));
        const reader = new HttpBlindPayReader('https://api.blindpay.com/v1', 'in_123', 'bp_key', fetchImpl);

        await expect(reader.getPayout('po_1')).resolves.toMatchObject({ id: 'po_1' });
        expect(fetchImpl).toHaveBeenCalledWith('https://api.blindpay.com/v1/instances/in_123/payouts/po_1', {
            headers: { Authorization: 'Bearer bp_key', Accept: 'application/json' },
        });
    });

    it('reports HTTP errors without leaking the key', async () => {
        const reader = new HttpBlindPayReader('https://api.blindpay.com/v1', 'in_123', 'bp_secret_key', async () => ({
            ok: false,
            status: 401,
            json: async () => ({}),
        }));
        const error = await reader.getPayout('po_1').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BlindPayReadError);
        expect((error as Error).message).toBe('BlindPay returned HTTP 401 for payout po_1');
        expect((error as Error).message).not.toContain('bp_secret_key');
    });
});
