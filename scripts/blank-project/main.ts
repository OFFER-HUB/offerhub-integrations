/**
 * Runs inside the throwaway project (see scripts/check-blank-project.mjs):
 * everything here uses only what `npm install` of the two packages provides.
 */
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { createServer } from 'https';
import { AddressInfo } from 'net';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
    EscrowClient,
    StellarRpcClient,
    TRUSTLESS_ERROR_CODES,
    TrustlessWorkAdapterModule,
    TrustlessWorkConfig,
} from '@offerhub-orchestrator/adapter-trustlesswork';
import {
    BLINDPAY_CORRIDORS,
    BlindPayAdapterModule,
    BlindPayConfig,
    BlindPayProviderException,
    BlindPayService,
    missingRailDetails,
} from '@offerhub-orchestrator/adapter-blindpay';

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
    console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failures.push(name);
}

@Module({ imports: [TrustlessWorkAdapterModule, BlindPayAdapterModule] })
class AppModule {}

async function main(): Promise<void> {
    // ── Config guards: a newcomer who forgot a variable gets a named error ──
    delete process.env.TRUSTLESS_API_KEY;
    let guard = '';
    try {
        new TrustlessWorkConfig();
    } catch (error) {
        guard = (error as Error).message;
    }
    check('TrustlessWorkConfig names the missing variable', guard.includes('TRUSTLESS_API_KEY'), guard);

    // ── A local HTTPS stand-in for BlindPay ──
    const requests: Array<{ method: string; url: string; auth: string; body: string }> = [];
    const server = createServer(
        { key: readFileSync('key.pem'), cert: readFileSync('cert.pem') },
        (req, res) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                requests.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers.authorization), body });
                res.setHeader('content-type', 'application/json');
                if (req.url?.endsWith('/quotes')) {
                    res.end(JSON.stringify({ id: 'qu_blank', expires_at: Date.now() + 300_000, receiver_amount: 1700 }));
                } else if (req.url?.includes('/payouts/po_blank')) {
                    res.end(JSON.stringify({ id: 'po_blank', status: 'completed' }));
                } else {
                    res.statusCode = 503;
                    res.end(JSON.stringify({ message: 'maintenance' }));
                }
            });
        },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    Object.assign(process.env, {
        TRUSTLESS_API_KEY: 'blank_id.blank_secret',
        TRUSTLESS_WEBHOOK_SECRET: 'tw_whsec_blank_project',
        STELLAR_NETWORK: 'testnet',
        BLINDPAY_API_KEY: 'bp_blank_key',
        BLINDPAY_INSTANCE_ID: 'in_blank0000001',
        BLINDPAY_BASE_URL: `https://localhost:${port}/v1`,
        BLINDPAY_WEBHOOK_SECRET: 'whsec_blank_project',
        BLINDPAY_ENV: 'development',
    });

    // ── Boot a Nest app with both modules ──
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    check('Nest app boots with both modules', true);

    const twConfig = app.get(TrustlessWorkConfig);
    check('TrustlessWorkConfig reads the environment', twConfig.stellarNetwork === 'testnet' && twConfig.isTestnet());
    check('EscrowClient is injectable', app.get(EscrowClient) instanceof EscrowClient);

    // ── Trustless Work: a real read from the Stellar testnet RPC ──
    const rpc = app.get(StellarRpcClient);
    const health = await rpc.getHealth();
    check('StellarRpcClient reads the real testnet RPC', health.status === 'healthy', `latest ledger ${health.latestLedger}`);
    const ledger = await rpc.getLatestLedgerSequence();
    check('latest ledger is a positive number', ledger > 0, String(ledger));
    check('error codes are exported', TRUSTLESS_ERROR_CODES.ESCROW_NOT_FOUND === 'ESCROW_NOT_FOUND');

    // ── BlindPay against the stub ──
    const bpConfig = app.get(BlindPayConfig);
    check('BlindPayConfig builds the instance URL', bpConfig.instanceUrl === `https://localhost:${port}/v1/instances/in_blank0000001`);
    check('a development instance settles in USDB on testnet', bpConfig.token === 'USDB' && bpConfig.network === 'stellar_testnet');

    const blindPay = app.get(BlindPayService);
    const quote = await blindPay.createQuote({ bankAccountId: 'ba_blank', requestAmount: 1000, currencyType: 'sender' });
    check('createQuote returns the quote', quote.id === 'qu_blank');
    const sent = requests.find((r) => r.url.endsWith('/quotes'));
    check('createQuote posts to the instance with the bearer key', !!sent && sent.method === 'POST' && sent.auth === 'Bearer bp_blank_key', sent?.url);
    check('the quote body uses BlindPay field names', !!sent && JSON.parse(sent.body).bank_account_id === 'ba_blank');

    const payout = await blindPay.getPayoutStatus('po_blank');
    check('getPayoutStatus reads a payout', payout.status === 'completed');

    let thrown: unknown;
    try {
        await blindPay.createPayout({ quoteId: 'qu_blank', signedTransaction: 'XDR', senderWalletAddress: 'GABC' });
    } catch (error) {
        thrown = error;
    }
    check(
        'a 503 from BlindPay becomes a BlindPayProviderException with a code',
        thrown instanceof BlindPayProviderException && thrown.code === 'PROVIDER_UNAVAILABLE',
        thrown instanceof BlindPayProviderException ? thrown.code : String(thrown),
    );
    const postAttempts = requests.filter((r) => r.method === 'POST' && r.url.endsWith('/payouts/stellar')).length;
    check('a failed POST is never resent', postAttempts === 1, `${postAttempts} attempt(s)`);

    check('the four corridors are exported', Object.keys(BLINDPAY_CORRIDORS).join() === 'BR,MX,AR,CO');
    check('rail validation is exported', missingRailDetails('SPEI_BITSO', {}).join() === 'spei_protocol');

    await app.close();
    await new Promise((resolve) => server.close(resolve));

    if (failures.length > 0) {
        console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
