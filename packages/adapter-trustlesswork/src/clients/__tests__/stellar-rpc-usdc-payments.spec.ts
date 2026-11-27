/**
 * Unit tests for StellarRpcClient.getIncomingUsdcPayments() — the query
 * deposit detection runs on. Uses the real SDK for ScVal encoding, so the
 * events here are shaped exactly like what Stellar RPC returns for the USDC
 * Stellar Asset Contract (verified against testnet: a classic `payment` op
 * surfaces as `transfer [from, to, "USDC:<issuer>"]` with an i128 amount).
 */
import { Asset, Keypair, Networks, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { StellarRpcClient } from '../stellar-rpc.client';

const mockGetEvents = jest.fn();
const mockGetLatestLedger = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk');
    return {
        ...actual,
        rpc: {
            ...actual.rpc,
            Server: jest.fn().mockImplementation(() => ({
                getEvents: mockGetEvents,
                getLatestLedger: mockGetLatestLedger,
            })),
        },
    };
});

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_SAC = new Asset('USDC', ISSUER).contractId(Networks.TESTNET);
const ASSET = `USDC:${ISSUER}`;

const WALLET = Keypair.random().publicKey();
const SENDER = Keypair.random().publicKey();
const ESCROW_CONTRACT = 'CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA';

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const addr = (a: string) => nativeToScVal(a, { type: 'address' });
const str = (s: string) => nativeToScVal(s, { type: 'string' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

let seq = 0;
function event(topic: xdr.ScVal[], value: xdr.ScVal, overrides: Record<string, unknown> = {}) {
    seq++;
    return {
        id: `00000042949${String(seq).padStart(5, '0')}-0000000000`,
        type: 'contract',
        ledger: 1000,
        ledgerClosedAt: '2026-09-29T12:00:00Z',
        txHash: `tx_${seq}`,
        inSuccessfulContractCall: true,
        topic,
        value,
        ...overrides,
    };
}
const transfer = (from: string, to: string, amount: bigint, overrides = {}) =>
    event([sym('transfer'), addr(from), addr(to), str(ASSET)], i128(amount), overrides);
const mint = (to: string, amount: bigint) => event([sym('mint'), addr(to), str(ASSET)], i128(amount));

const page = (events: unknown[], cursor = 'c') => ({ events, cursor, latestLedger: 2000 });

function buildClient() {
    return new StellarRpcClient({
        stellarRpcUrl: 'https://soroban-testnet.stellar.org',
        stellarNetwork: 'testnet',
        stellarUsdcAssetCode: 'USDC',
        stellarUsdcIssuer: ISSUER,
    } as never);
}

describe('StellarRpcClient.getIncomingUsdcPayments()', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        seq = 0;
    });

    it('decodes a classic payment (transfer from a G account) into a 7-decimal amount', async () => {
        const e = transfer(SENDER, WALLET, 200_000_000n);
        mockGetEvents.mockResolvedValueOnce(page([e]));

        const payments = await buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001);

        expect(payments).toEqual([
            {
                id: e.id,
                txHash: e.txHash,
                ledger: 1000,
                ledgerClosedAt: '2026-09-29T12:00:00Z',
                from: SENDER,
                to: WALLET,
                amount: '20.0000000',
            },
        ]);
    });

    it('keeps sub-unit precision', async () => {
        mockGetEvents.mockResolvedValueOnce(page([transfer(SENDER, WALLET, 1n)]));
        const [payment] = await buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001);
        expect(payment.amount).toBe('0.0000001');
    });

    it('treats a mint (payment straight from the issuer) as a deposit from the issuer', async () => {
        mockGetEvents.mockResolvedValueOnce(page([mint(WALLET, 50_000_000n)]));
        const [payment] = await buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001);
        expect(payment).toMatchObject({ from: ISSUER, to: WALLET, amount: '5.0000000' });
    });

    it('reads the amount out of the muxed-destination map form', async () => {
        const value = nativeToScVal(
            { amount: 30_000_000n, to_muxed_id: 7n },
            { type: { amount: ['symbol', 'i128'], to_muxed_id: ['symbol', 'u64'] } },
        );
        mockGetEvents.mockResolvedValueOnce(
            page([event([sym('transfer'), addr(SENDER), addr(WALLET), str(ASSET)], value)]),
        );
        const [payment] = await buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001);
        expect(payment.amount).toBe('3.0000000');
    });

    it('skips transfers out of a contract — escrow releases are not deposits', async () => {
        mockGetEvents.mockResolvedValueOnce(page([transfer(ESCROW_CONTRACT, WALLET, 10_000_000n)]));
        expect(await buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001)).toEqual([]);
    });

    it('skips events from failed contract calls', async () => {
        mockGetEvents.mockResolvedValueOnce(
            page([transfer(SENDER, WALLET, 10_000_000n, { inSuccessfulContractCall: false })]),
        );
        expect(await buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001)).toEqual([]);
    });

    it('skips payments to addresses that were not asked for', async () => {
        mockGetEvents.mockResolvedValueOnce(page([transfer(SENDER, Keypair.random().publicKey(), 1n)]));
        expect(await buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001)).toEqual([]);
    });

    it('filters server-side on the USDC SAC, with transfer and mint patterns per recipient', async () => {
        mockGetEvents.mockResolvedValueOnce(page([]));
        await buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001);

        const request = mockGetEvents.mock.calls[0][0];
        expect(request).toMatchObject({ startLedger: 1000, endLedger: 1001 });
        expect(request.filters).toEqual([
            {
                type: 'contract',
                contractIds: [USDC_SAC],
                topics: [
                    [sym('transfer').toXDR('base64'), '*', addr(WALLET).toXDR('base64'), '*'],
                    [sym('mint').toXDR('base64'), addr(WALLET).toXDR('base64'), '*'],
                ],
            },
        ]);
    });

    it('batches recipients to stay within 5 filters x 5 topics per request', async () => {
        mockGetEvents.mockResolvedValue(page([]));
        const wallets = Array.from({ length: 30 }, () => Keypair.random().publicKey());

        await buildClient().getIncomingUsdcPayments(wallets, 1000, 1001);

        // 12 recipients (24 patterns) per request -> 12 + 12 + 6
        expect(mockGetEvents).toHaveBeenCalledTimes(3);
        for (const [request] of mockGetEvents.mock.calls) {
            expect(request.filters.length).toBeLessThanOrEqual(5);
            for (const filter of request.filters) {
                expect(filter.topics.length).toBeLessThanOrEqual(5);
            }
        }
    });

    it('pages with the cursor and trims events past endLedger', async () => {
        const full = Array.from({ length: 1000 }, () => transfer(SENDER, WALLET, 1n));
        const beyond = transfer(SENDER, WALLET, 1n, { ledger: 1001 });
        const lastInRange = transfer(SENDER, WALLET, 2n);
        mockGetEvents
            .mockResolvedValueOnce(page(full, 'cursor-1'))
            .mockResolvedValueOnce(page([lastInRange, beyond], 'cursor-2'));

        const payments = await buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001);

        expect(mockGetEvents).toHaveBeenCalledTimes(2);
        expect(mockGetEvents.mock.calls[1][0]).toEqual(
            expect.objectContaining({ cursor: 'cursor-1', limit: 1000 }),
        );
        expect(mockGetEvents.mock.calls[1][0].startLedger).toBeUndefined();
        expect(payments).toHaveLength(1001);
        expect(payments.some((p) => p.ledger === 1001)).toBe(false);
    });

    it('scans a long range in 1,000-ledger windows, so no request exceeds the provider limit', async () => {
        const late = transfer(SENDER, WALLET, 5n, { ledger: 2_500 });
        mockGetEvents
            .mockResolvedValueOnce(page([]))
            .mockResolvedValueOnce(page([late]))
            .mockResolvedValueOnce(page([]));

        const payments = await buildClient().getIncomingUsdcPayments([WALLET], 1000, 3_001);

        const ranges = mockGetEvents.mock.calls.map(([req]) => [req.startLedger, req.endLedger]);
        expect(ranges).toEqual([
            [1000, 2000],
            [2000, 3000],
            [3000, 3001],
        ]);
        expect(payments.map((p) => p.id)).toEqual([late.id]);
    });

    it('halves the window when the provider rejects the scan as too much work', async () => {
        mockGetEvents
            .mockRejectedValueOnce({ code: -32001, message: '[-32001] request exceeded processing limit threshold' })
            .mockResolvedValue(page([]));

        await buildClient().getIncomingUsdcPayments([WALLET], 1000, 2_000);

        const ranges = mockGetEvents.mock.calls.map(([req]) => [req.startLedger, req.endLedger]);
        expect(ranges).toEqual([
            [1000, 2000],
            [1000, 1500],
            [1500, 2000],
        ]);
    });

    it('gives up below the minimum window and reports the provider message', async () => {
        mockGetEvents.mockRejectedValue({ code: -32001, message: '[-32001] request exceeded processing limit threshold' });

        await expect(buildClient().getIncomingUsdcPayments([WALLET], 1000, 2_000)).rejects.toMatchObject({
            message: 'Stellar RPC error: [-32001] request exceeded processing limit threshold',
        });
    });

    it('stops once the cursor reaches the end of the range', async () => {
        const cursorAt = (ledger: number) =>
            `${(BigInt(ledger) << 32n).toString().padStart(19, '0')}-4294967295`;
        mockGetEvents.mockResolvedValueOnce(page([], cursorAt(1000)));

        await buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001);

        expect(mockGetEvents).toHaveBeenCalledTimes(1);
    });

    it('returns payments across batches in event order', async () => {
        const wallets = [WALLET, ...Array.from({ length: 12 }, () => Keypair.random().publicKey())];
        const later = transfer(SENDER, WALLET, 1n);
        const earlier = { ...transfer(SENDER, wallets[12], 1n), id: '0000000000000000001-0000000000' };
        mockGetEvents.mockResolvedValueOnce(page([later])).mockResolvedValueOnce(page([earlier]));

        const payments = await buildClient().getIncomingUsdcPayments(wallets, 1000, 1001);

        expect(payments.map((p) => p.id)).toEqual([earlier.id, later.id]);
    });

    it('maps RPC failures to STELLAR_NETWORK_ERROR', async () => {
        mockGetEvents.mockRejectedValueOnce(new Error('503'));
        await expect(buildClient().getIncomingUsdcPayments([WALLET], 1000, 1001)).rejects.toMatchObject({
            message: 'Stellar RPC error: 503',
        });
    });
});

describe('StellarRpcClient.getLatestLedgerSequence()', () => {
    it('returns the sequence number', async () => {
        mockGetLatestLedger.mockResolvedValueOnce({ id: 'x', sequence: 4941231, protocolVersion: 23 });
        expect(await buildClient().getLatestLedgerSequence()).toBe(4941231);
    });
});
