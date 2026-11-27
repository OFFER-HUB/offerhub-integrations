/**
 * The escrow payload sent to TrustlessWork's deployer must carry the asset of
 * the configured network (#312): a mainnet escrow deployed against the
 * testnet USDC issuer would lock funds in an asset nobody holds. fetch is
 * faked; only the request URL and body matter here.
 */
import { EscrowClient } from '../escrow.client';
import type { CreateEscrowDto } from '../../dto/escrow.dto';

const MAINNET_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const BUYER = 'GCKFBEIYTKP5RDBQMTVVALONAOPBXICILMAFQGODMHCM5EBMQ2GDJ5Q4';
const SELLER = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
const PLATFORM = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37';

describe('EscrowClient.createEscrow network values', () => {
    const fetchMock = jest.fn();
    const originalFetch = global.fetch;

    beforeEach(() => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ status: 'SUCCESS', unsignedTransaction: 'AAAA' }),
            text: async () => JSON.stringify({ status: 'SUCCESS', unsignedTransaction: 'AAAA' }),
        });
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.clearAllMocks();
    });

    it('deploys against the configured network API, asset and roles', async () => {
        const config = {
            apiUrl: 'https://api.trustlesswork.com',
            apiKey: 'key_id.key_secret',
            stellarUsdcAssetCode: 'USDC',
            stellarUsdcIssuer: MAINNET_ISSUER,
        };
        const client = new EscrowClient(config as never);
        const dto = {
            order_id: 'ord_test',
            amount: '10.00',
            buyer_address: BUYER,
            seller_address: SELLER,
        } as CreateEscrowDto;

        await client.createEscrow(dto, PLATFORM, PLATFORM);

        const [url, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(url).toBe('https://api.trustlesswork.com/deployer/single-release');
        expect(body.trustline).toEqual({ address: MAINNET_ISSUER, symbol: 'USDC' });
        expect(body.roles).toEqual({
            approver: BUYER,
            serviceProvider: SELLER,
            platformAddress: PLATFORM,
            releaseSigner: BUYER,
            disputeResolver: PLATFORM,
            receiver: SELLER,
        });
    });

    it('can collect the fee on one address and resolve disputes with another', async () => {
        const FEE = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
        const client = new EscrowClient({
            apiUrl: 'https://api.trustlesswork.com',
            apiKey: 'key_id.key_secret',
            stellarUsdcAssetCode: 'USDC',
            stellarUsdcIssuer: MAINNET_ISSUER,
        } as never);

        await client.createEscrow(
            { order_id: 'ord_test', amount: '10.00', buyer_address: BUYER, seller_address: SELLER } as CreateEscrowDto,
            BUYER,
            FEE,
            PLATFORM,
        );

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.roles.platformAddress).toBe(FEE);
        expect(body.roles.disputeResolver).toBe(PLATFORM);
    });
});
