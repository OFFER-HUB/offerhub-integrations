import { Asset, Keypair, rpc, xdr } from '@stellar/stellar-sdk';

/** Read-only ledger access the runner needs, behind an interface so tests don't hit the network. */
export interface LedgerReader {
    /** USDC balance of `publicKey` as a 7-decimal string, or null when the account or trustline is missing */
    usdcBalance(publicKey: string): Promise<string | null>;
    /** Looks a transaction up by hash in the ledger */
    getTransaction(hash: string): Promise<TxLookup>;
}

export type TxLookup = { status: 'NOT_FOUND' } | { status: 'SUCCESS' | 'FAILED'; ledger: number; closedAtUnix: number };

/** Stellar RPC implementation (`getLedgerEntries` on the trustline entry). */
export class RpcLedgerReader implements LedgerReader {
    private readonly server: rpc.Server;

    constructor(
        rpcUrl: string,
        private readonly assetCode: string,
        private readonly issuer: string,
    ) {
        this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    }

    async usdcBalance(publicKey: string): Promise<string | null> {
        const asset = new Asset(this.assetCode, this.issuer);
        const key = xdr.LedgerKey.trustline(
            new xdr.LedgerKeyTrustLine({
                accountId: Keypair.fromPublicKey(publicKey).xdrPublicKey(),
                asset: asset.toTrustLineXDRObject(),
            }),
        );
        const { entries } = await this.server.getLedgerEntries(key);
        if (entries.length === 0) return null;
        const stroops = entries[0].val.trustLine().balance().toBigInt();
        return formatStroops(stroops);
    }

    async getTransaction(hash: string): Promise<TxLookup> {
        const res = await this.server.getTransaction(hash);
        if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { status: 'NOT_FOUND' };
        return {
            status: res.status === rpc.Api.GetTransactionStatus.SUCCESS ? 'SUCCESS' : 'FAILED',
            ledger: res.ledger,
            // Typed as a number, but RPC servers return it as a string
            closedAtUnix: Number(res.createdAt),
        };
    }
}

export function formatStroops(stroops: bigint): string {
    const whole = stroops / 10_000_000n;
    const fraction = (stroops % 10_000_000n).toString().padStart(7, '0');
    return `${whole}.${fraction}`;
}

/** Compares two decimal strings with up to 7 places without floating point. */
export function toStroops(amount: string): bigint {
    const [whole, fraction = ''] = amount.split('.');
    return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0').slice(0, 7));
}
