/**
 * Unit tests for the StellarRpcClient methods the wallet flows moved onto in
 * #308: account state and balances (getLedgerEntries) and classic transaction
 * submission (sendTransaction + pollTransaction). Uses the real SDK's XDR, so
 * the ledger entries and transaction results here are shaped exactly like
 * what Stellar RPC returns.
 */
import {
    Account,
    Asset,
    BASE_FEE,
    Keypair,
    Networks,
    Operation,
    TransactionBuilder,
    rpc as StellarRpc,
    xdr,
} from '@stellar/stellar-sdk';
import { TRUSTLESS_ERROR_CODES as ERROR_CODES } from '../../errors';
import { StellarRpcClient, StellarTransactionFailedError } from '../stellar-rpc.client';

const mockGetLedgerEntries = jest.fn();
const mockGetTransaction = jest.fn();
const mockSendTransaction = jest.fn();
const mockPollTransaction = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk');
    return {
        ...actual,
        rpc: {
            ...actual.rpc,
            Server: jest.fn().mockImplementation(() => ({
                getLedgerEntries: mockGetLedgerEntries,
                getTransaction: mockGetTransaction,
                sendTransaction: mockSendTransaction,
                pollTransaction: mockPollTransaction,
            })),
        },
    };
});

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = new Asset('USDC', ISSUER);

const ACCOUNT = Keypair.random();
/** XDR for an `ext` union in its v0 (void) arm. */
const EMPTY_EXT = Buffer.alloc(4);
const COSIGNER = Keypair.random();

function buildClient() {
    return new StellarRpcClient({
        stellarRpcUrl: 'https://soroban-testnet.stellar.org',
        stellarNetwork: 'testnet',
        stellarUsdcAssetCode: 'USDC',
        stellarUsdcIssuer: ISSUER,
    } as never);
}

function accountEntry(opts: { balance: bigint; masterWeight: number; cosignerWeight?: number }) {
    const signers =
        opts.cosignerWeight === undefined
            ? []
            : [
                  new xdr.Signer({
                      key: xdr.SignerKey.signerKeyTypeEd25519(COSIGNER.rawPublicKey()),
                      weight: opts.cosignerWeight,
                  }),
              ];
    return {
        val: xdr.LedgerEntryData.account(
            new xdr.AccountEntry({
                accountId: ACCOUNT.xdrAccountId(),
                balance: xdr.Int64.fromString(opts.balance.toString()),
                seqNum: xdr.Int64.fromString('4294967296'),
                numSubEntries: signers.length,
                inflationDest: null,
                flags: 0,
                homeDomain: '',
                thresholds: Buffer.from([opts.masterWeight, 1, 1, 1]),
                signers,
                ext: xdr.AccountEntryExt.fromXDR(EMPTY_EXT),
            }),
        ),
    };
}

function trustlineEntry(balance: bigint) {
    return {
        val: xdr.LedgerEntryData.trustline(
            new xdr.TrustLineEntry({
                accountId: ACCOUNT.xdrAccountId(),
                asset: USDC.toTrustLineXDRObject(),
                balance: xdr.Int64.fromString(balance.toString()),
                limit: xdr.Int64.fromString('9223372036854775807'),
                flags: 1,
                ext: xdr.TrustLineEntryExt.fromXDR(EMPTY_EXT),
            }),
        ),
    };
}

function signedTransaction() {
    const tx = new TransactionBuilder(new Account(ACCOUNT.publicKey(), '1'), {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
    })
        .addOperation(Operation.setOptions({ masterWeight: 0 }))
        .setTimeout(30)
        .build();
    tx.sign(ACCOUNT);
    return tx;
}

function transactionResult(result: xdr.TransactionResultResult): xdr.TransactionResult {
    return new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString('100'),
        result,
        ext: xdr.TransactionResultExt.fromXDR(EMPTY_EXT),
    });
}

const setOptionsResult = (result: xdr.SetOptionsResult) =>
    xdr.OperationResult.opInner(xdr.OperationResultTr.setOptions(result));

describe('StellarRpcClient — accounts and submission', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // clearAllMocks keeps queued *Once values; a test that throws early
        // must not leak them into the next one.
        for (const mock of [
            mockGetLedgerEntries,
            mockGetTransaction,
            mockSendTransaction,
            mockPollTransaction,
        ]) {
            mock.mockReset();
        }
    });

    describe('getAccountState', () => {
        it('returns the sequence and every signer, master key included', async () => {
            mockGetLedgerEntries.mockResolvedValueOnce({
                entries: [accountEntry({ balance: 0n, masterWeight: 0, cosignerWeight: 1 })],
            });

            const state = await buildClient().getAccountState(ACCOUNT.publicKey());

            expect(state?.account.accountId()).toBe(ACCOUNT.publicKey());
            expect(state?.account.sequenceNumber()).toBe('4294967296');
            expect(state?.signers).toEqual([
                { key: ACCOUNT.publicKey(), weight: 0 },
                { key: COSIGNER.publicKey(), weight: 1 },
            ]);
        });

        it('returns null when the account is not on the ledger', async () => {
            mockGetLedgerEntries.mockResolvedValueOnce({ entries: [] });

            expect(await buildClient().getAccountState(ACCOUNT.publicKey())).toBeNull();
        });

        it('maps RPC failures to STELLAR_NETWORK_ERROR', async () => {
            mockGetLedgerEntries.mockRejectedValueOnce(new Error('connection refused'));

            await expect(buildClient().getAccountState(ACCOUNT.publicKey())).rejects.toMatchObject({
                code: ERROR_CODES.STELLAR_NETWORK_ERROR,
            });
        });
    });

    describe('loadAccount', () => {
        it('throws when the account is not on the ledger', async () => {
            mockGetLedgerEntries.mockResolvedValueOnce({ entries: [] });

            await expect(buildClient().loadAccount(ACCOUNT.publicKey())).rejects.toThrow(/not found/);
        });
    });

    describe('getAccountBalances', () => {
        it('reads native and trustline balances in one request', async () => {
            mockGetLedgerEntries.mockResolvedValueOnce({
                entries: [
                    trustlineEntry(1_000_000_000n),
                    accountEntry({ balance: 50_000_000n, masterWeight: 1 }),
                ],
            });

            const balances = await buildClient().getAccountBalances(ACCOUNT.publicKey(), USDC);

            expect(balances).toEqual({ native: 50_000_000n, asset: 1_000_000_000n });
            expect(mockGetLedgerEntries).toHaveBeenCalledTimes(1);
            const keys = mockGetLedgerEntries.mock.calls[0] as xdr.LedgerKey[];
            expect(keys.map((key) => key.switch().name)).toEqual(['account', 'trustline']);
        });

        it('reports a missing trustline as null, not zero', async () => {
            mockGetLedgerEntries.mockResolvedValueOnce({
                entries: [accountEntry({ balance: 50_000_000n, masterWeight: 1 })],
            });

            const balances = await buildClient().getAccountBalances(ACCOUNT.publicKey(), USDC);

            expect(balances).toEqual({ native: 50_000_000n, asset: null });
        });

        it('returns null when the account is not on the ledger', async () => {
            mockGetLedgerEntries.mockResolvedValueOnce({ entries: [] });

            expect(await buildClient().getAccountBalances(ACCOUNT.publicKey(), USDC)).toBeNull();
        });
    });

    describe('isTransactionSuccessful', () => {
        it.each([
            [StellarRpc.Api.GetTransactionStatus.SUCCESS, true],
            [StellarRpc.Api.GetTransactionStatus.FAILED, false],
            [StellarRpc.Api.GetTransactionStatus.NOT_FOUND, false],
        ])('maps %s to %s', async (status, expected) => {
            mockGetTransaction.mockResolvedValueOnce({ status });

            expect(await buildClient().isTransactionSuccessful('abc')).toBe(expected);
        });
    });

    describe('submitTransaction', () => {
        it('returns the hash once the transaction succeeds on the ledger', async () => {
            const tx = signedTransaction();
            const hash = tx.hash().toString('hex');
            mockSendTransaction.mockResolvedValueOnce({ status: 'PENDING', hash });
            mockPollTransaction.mockResolvedValueOnce({
                status: StellarRpc.Api.GetTransactionStatus.SUCCESS,
            });

            await expect(buildClient().submitTransaction(tx)).resolves.toBe(hash);
            expect(mockPollTransaction).toHaveBeenCalledWith(hash, expect.any(Object));
        });

        it('waits on a DUPLICATE submission instead of failing it', async () => {
            const tx = signedTransaction();
            mockSendTransaction.mockResolvedValueOnce({ status: 'DUPLICATE' });
            mockPollTransaction.mockResolvedValueOnce({
                status: StellarRpc.Api.GetTransactionStatus.SUCCESS,
            });

            await expect(buildClient().submitTransaction(tx)).resolves.toBe(tx.hash().toString('hex'));
        });

        it('reports a rejected submission with Horizon-style result codes', async () => {
            mockSendTransaction.mockResolvedValueOnce({
                status: 'ERROR',
                errorResult: transactionResult(xdr.TransactionResultResult.txBadAuth()),
            });

            const error = await buildClient()
                .submitTransaction(signedTransaction())
                .catch((e: unknown) => e);

            expect(error).toBeInstanceOf(StellarTransactionFailedError);
            expect((error as StellarTransactionFailedError).resultCodes).toEqual(['tx_bad_auth']);
            expect(mockPollTransaction).not.toHaveBeenCalled();
        });

        it('reports operation codes when the transaction fails in the ledger', async () => {
            mockSendTransaction.mockResolvedValueOnce({ status: 'PENDING' });
            mockPollTransaction.mockResolvedValueOnce({
                status: StellarRpc.Api.GetTransactionStatus.FAILED,
                resultXdr: transactionResult(
                    xdr.TransactionResultResult.txFailed([
                        setOptionsResult(xdr.SetOptionsResult.setOptionsSuccess()),
                        setOptionsResult(xdr.SetOptionsResult.setOptionsLowReserve()),
                        xdr.OperationResult.opBadAuth(),
                    ]),
                ),
            });

            const error = await buildClient()
                .submitTransaction(signedTransaction())
                .catch((e: unknown) => e);

            expect((error as StellarTransactionFailedError).resultCodes).toEqual([
                'tx_failed',
                'op_success',
                'op_low_reserve',
                'op_bad_auth',
            ]);
        });

        it('fails with try_again_later when the node is congested', async () => {
            mockSendTransaction.mockResolvedValueOnce({ status: 'TRY_AGAIN_LATER' });

            const error = await buildClient()
                .submitTransaction(signedTransaction())
                .catch((e: unknown) => e);

            expect((error as StellarTransactionFailedError).resultCodes).toEqual(['try_again_later']);
        });

        it('fails with submission_timeout when the transaction never lands', async () => {
            mockSendTransaction.mockResolvedValueOnce({ status: 'PENDING' });
            mockPollTransaction.mockResolvedValueOnce({
                status: StellarRpc.Api.GetTransactionStatus.NOT_FOUND,
            });

            const error = await buildClient()
                .submitTransaction(signedTransaction())
                .catch((e: unknown) => e);

            expect((error as StellarTransactionFailedError).resultCodes).toEqual([
                'submission_timeout',
            ]);
        });

        it('maps a network failure to STELLAR_NETWORK_ERROR', async () => {
            mockSendTransaction.mockRejectedValueOnce(new Error('socket hang up'));

            await expect(
                buildClient().submitTransaction(signedTransaction()),
            ).rejects.toMatchObject({ code: ERROR_CODES.STELLAR_NETWORK_ERROR });
        });
    });
});
