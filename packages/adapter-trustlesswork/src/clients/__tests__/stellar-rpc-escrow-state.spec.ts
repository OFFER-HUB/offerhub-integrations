/**
 * Unit tests for StellarRpcClient.getEscrowState(). Ledger entries are built
 * with the real SDK in the shape TrustlessWork contracts actually use on
 * testnet and mainnet: the escrow struct as its own persistent entry under
 * `["Escrow"]` (the contract instance's storage is empty), funds as a
 * `["Balance", <contract>]` entry on the token's SAC. An older layout with the
 * struct inside instance storage is still read, as a fallback.
 */
import { Address, Asset, Networks, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { StellarRpcClient } from '../stellar-rpc.client';

const mockGetLedgerEntries = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk');
    return {
        ...actual,
        rpc: {
            ...actual.rpc,
            Server: jest.fn().mockImplementation(() => ({ getLedgerEntries: mockGetLedgerEntries })),
        },
    };
});

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_SAC = new Asset('USDC', ISSUER).contractId(Networks.TESTNET);
const ESCROW = 'CB62PACFHN7HMNYFMU3Z6GJ3WNWG44ZFUTJPYH5KFCYFIFT6TLQ7WHLG';

const flagsVal = (f: { disputed?: boolean; released?: boolean; resolved?: boolean }) => ({
    disputed: f.disputed ?? false,
    released: f.released ?? false,
    resolved: f.resolved ?? false,
});

function contractDataEntry(contract: string, key: xdr.ScVal, val: xdr.ScVal) {
    return {
        key: xdr.LedgerKey.contractData(
            new xdr.LedgerKeyContractData({
                contract: new Address(contract).toScAddress(),
                key,
                durability: xdr.ContractDataDurability.persistent(),
            }),
        ),
        val: xdr.LedgerEntryData.contractData(
            new xdr.ContractDataEntry({
                ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
                contract: new Address(contract).toScAddress(),
                key,
                durability: xdr.ContractDataDurability.persistent(),
                val,
            }),
        ),
        lastModifiedLedgerSeq: 1,
    };
}

function instanceEntry(escrow: Record<string, unknown>) {
    const instance = new xdr.ScContractInstance({
        executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
        storage: [
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Escrow')]),
                val: nativeToScVal(escrow),
            }),
        ],
    });
    return contractDataEntry(ESCROW, xdr.ScVal.scvLedgerKeyContractInstance(), xdr.ScVal.scvContractInstance(instance));
}

/** The real layout: the struct under ["Escrow"] in persistent storage, the instance's storage empty. */
function persistentEscrowEntry(escrow: Record<string, unknown>) {
    return contractDataEntry(ESCROW, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Escrow')]), nativeToScVal(escrow));
}

function emptyInstanceEntry() {
    const instance = new xdr.ScContractInstance({
        executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
        storage: [],
    });
    return contractDataEntry(ESCROW, xdr.ScVal.scvLedgerKeyContractInstance(), xdr.ScVal.scvContractInstance(instance));
}

function balanceEntry(amount: bigint, token = USDC_SAC) {
    const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Balance'), new Address(ESCROW).toScVal()]);
    const val = nativeToScVal(
        { amount, authorized: true, clawback: false },
        { type: { amount: ['symbol', 'i128'], authorized: ['symbol', null], clawback: ['symbol', null] } },
    );
    return contractDataEntry(token, key, val);
}

const singleRelease = (flags = {}, trustline = USDC_SAC) => ({
    amount: 50_000_000n,
    engagement_id: 'ord_1',
    flags: flagsVal(flags),
    milestones: [{ approved: true, description: 'x', evidence: '', status: 'completed' }],
    trustline: { address: trustline },
});

function buildClient() {
    return new StellarRpcClient({
        stellarRpcUrl: 'https://soroban-testnet.stellar.org',
        stellarNetwork: 'testnet',
        stellarUsdcAssetCode: 'USDC',
        stellarUsdcIssuer: ISSUER,
    } as never);
}

const respond = (...entries: unknown[]) => ({ entries, latestLedger: 1 });

describe('StellarRpcClient.getEscrowState()', () => {
    beforeEach(() => jest.clearAllMocks());

    it('reads the escrow from its persistent ["Escrow"] entry, the way TrustlessWork stores it', async () => {
        mockGetLedgerEntries
            .mockResolvedValueOnce(respond(emptyInstanceEntry(), persistentEscrowEntry(singleRelease({ released: true }))))
            .mockResolvedValueOnce(respond(balanceEntry(0n)));

        const state = await buildClient().getEscrowState(ESCROW);

        expect(state).toEqual({ flags: { disputed: false, released: true, resolved: false }, balance: 0n });
    });

    it('asks for the instance and the persistent escrow entry in one call', async () => {
        mockGetLedgerEntries
            .mockResolvedValueOnce(respond(emptyInstanceEntry(), persistentEscrowEntry(singleRelease())))
            .mockResolvedValueOnce(respond(balanceEntry(5n)));

        await buildClient().getEscrowState(ESCROW);

        const keys = mockGetLedgerEntries.mock.calls[0] as xdr.LedgerKey[];
        expect(keys).toHaveLength(2);
        expect(keys[0].contractData().key().switch()).toBe(xdr.ScValType.scvLedgerKeyContractInstance());
        expect(keys[1].contractData().key().toXDR('base64')).toBe(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Escrow')]).toXDR('base64'));
    });

    it('prefers the persistent entry when both layouts are present', async () => {
        mockGetLedgerEntries
            .mockResolvedValueOnce(
                respond(instanceEntry(singleRelease({ disputed: true })), persistentEscrowEntry(singleRelease({ released: true }))),
            )
            .mockResolvedValueOnce(respond());

        expect((await buildClient().getEscrowState(ESCROW))?.flags).toEqual({ disputed: false, released: true, resolved: false });
    });

    it('reads a persistent escrow even if the instance entry is not returned', async () => {
        mockGetLedgerEntries
            .mockResolvedValueOnce(respond(persistentEscrowEntry(singleRelease())))
            .mockResolvedValueOnce(respond(balanceEntry(7n)));

        expect(await buildClient().getEscrowState(ESCROW)).toEqual({ flags: flagsVal({}), balance: 7n });
    });

    it('fails, naming both places, when the contract exists but holds no escrow', async () => {
        mockGetLedgerEntries.mockResolvedValueOnce(respond(emptyInstanceEntry()));

        await expect(buildClient().getEscrowState(ESCROW)).rejects.toThrow('Stellar RPC error');
    });

    it('still reads the older layout with the struct in instance storage', async () => {
        mockGetLedgerEntries
            .mockResolvedValueOnce(respond(instanceEntry(singleRelease({ released: true }))))
            .mockResolvedValueOnce(respond(balanceEntry(0n)));

        const state = await buildClient().getEscrowState(ESCROW);

        expect(state).toEqual({ flags: { disputed: false, released: true, resolved: false }, balance: 0n });
    });

    it('reports a funded escrow balance in stroops', async () => {
        mockGetLedgerEntries
            .mockResolvedValueOnce(respond(instanceEntry(singleRelease())))
            .mockResolvedValueOnce(respond(balanceEntry(100_000_000n)));

        expect((await buildClient().getEscrowState(ESCROW))?.balance).toBe(100_000_000n);
    });

    it('asks for the balance on the escrow\'s own trustline token', async () => {
        const otherToken = new Asset('EURC', ISSUER).contractId(Networks.TESTNET);
        mockGetLedgerEntries
            .mockResolvedValueOnce(respond(instanceEntry(singleRelease({}, otherToken))))
            .mockResolvedValueOnce(respond());

        await buildClient().getEscrowState(ESCROW);

        const balanceKey = mockGetLedgerEntries.mock.calls[1][0] as xdr.LedgerKey;
        expect(Address.fromScAddress(balanceKey.contractData().contract()).toString()).toBe(otherToken);
    });

    it('treats a missing balance entry as zero', async () => {
        mockGetLedgerEntries
            .mockResolvedValueOnce(respond(instanceEntry(singleRelease())))
            .mockResolvedValueOnce(respond());

        expect((await buildClient().getEscrowState(ESCROW))?.balance).toBe(0n);
    });

    it('returns null when the contract is not on the ledger', async () => {
        mockGetLedgerEntries.mockResolvedValueOnce(respond());
        expect(await buildClient().getEscrowState(ESCROW)).toBeNull();
        expect(mockGetLedgerEntries).toHaveBeenCalledTimes(1);
    });

    it('rolls up per-milestone flags for a multi-release escrow', async () => {
        const multi = (milestoneFlags: Array<Parameters<typeof flagsVal>[0]>) => ({
            engagement_id: 'ord_1',
            milestones: milestoneFlags.map((f) => ({ description: 'm', flags: flagsVal(f) })),
            trustline: { address: USDC_SAC },
        });
        const read = async (milestoneFlags: Array<Parameters<typeof flagsVal>[0]>) => {
            mockGetLedgerEntries
                .mockResolvedValueOnce(respond(instanceEntry(multi(milestoneFlags))))
                .mockResolvedValueOnce(respond());
            return (await buildClient().getEscrowState(ESCROW))?.flags;
        };

        expect(await read([{ released: true }, { released: true }])).toEqual({ disputed: false, released: true, resolved: false });
        expect(await read([{ released: true }, {}])).toEqual({ disputed: false, released: false, resolved: false });
        expect(await read([{ released: true }, { disputed: true }])).toEqual({ disputed: true, released: false, resolved: false });
        expect(await read([{ released: true }, { resolved: true }])).toEqual({ disputed: false, released: false, resolved: true });
    });

    it('fails loudly on an unrecognized escrow layout rather than guessing a status', async () => {
        mockGetLedgerEntries.mockResolvedValueOnce(respond(instanceEntry({ engagement_id: 'ord_1' })));
        await expect(buildClient().getEscrowState(ESCROW)).rejects.toThrow('Stellar RPC error');
    });
});
