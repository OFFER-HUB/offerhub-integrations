import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { Reporter, RunReport } from './types';

const EXPLORER = {
    testnet: 'https://stellar.expert/explorer/testnet',
    mainnet: 'https://stellar.expert/explorer/public',
} as const;

export function txUrl(network: RunReport['network'], hash: string): string {
    return `${EXPLORER[network]}/tx/${hash}`;
}

/** Human-readable summary on stdout (and in the GitHub Actions log). */
export class ConsoleReporter implements Reporter {
    constructor(private readonly write: (line: string) => void = (l) => console.log(l)) {}

    async publish(report: RunReport): Promise<void> {
        const icon = { passed: '✔', failed: '✖', skipped: '·' } as const;
        this.write(`\nValidation run ${report.id} — ${report.corridor} on ${report.network}: ${report.status.toUpperCase()} (${report.durationMs} ms)`);
        if (report.orderId) this.write(`  order ${report.orderId}${report.contractId ? `, escrow ${report.contractId}` : ''}`);
        for (const step of report.steps) {
            this.write(`  ${icon[step.status]} ${step.name} (${step.durationMs} ms)${step.error ? ` — ${step.error}` : ''}`);
            step.txHashes.forEach((hash, i) => {
                const c = step.confirmations[i];
                const onChain = c
                    ? c.status === 'SUCCESS'
                        ? ` (confirmed in ledger ${c.ledger}, ${c.confirmedInMs} ms)`
                        : ` (${c.status})`
                    : '';
                this.write(`      ${txUrl(report.network, hash)}${onChain}`);
            });
            if (step.payoutId) this.write(`      payout ${step.payoutId}`);
        }
        const r = report.receipt;
        if (r) {
            const rail = r.paymentProvider ? ` via ${r.paymentProvider}${r.providerTransactionId ? ` (${r.providerTransactionId})` : ''}` : '';
            this.write(`  receipt: BlindPay ${r.blindpayPayoutId} completed ${r.completedAt}, ${r.receiverAmountMinor} ${r.currency} minor units${rail}`);
            if (r.stellarTxHash) {
                const match = r.matchesPayoutTransfer === null ? '' : r.matchesPayoutTransfer ? ' (= seller transfer)' : ' (≠ seller transfer!)';
                this.write(`      ${txUrl(report.network, r.stellarTxHash)}${match}`);
            }
        }
    }
}

/** One JSON file per run, e.g. for upload as a CI artifact. */
export class JsonFileReporter implements Reporter {
    constructor(private readonly dir: string) {}

    async publish(report: RunReport): Promise<void> {
        const file = join(this.dir, `${report.id}-${report.corridor}.json`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    }
}

type PostLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
}>;

export class PublishError extends Error {}

/**
 * Publishes every finished run to the API's public results endpoint (#318),
 * which offer-hub.org/stats reads. Re-publishing the same run id replaces it.
 */
export class ApiReporter implements Reporter {
    constructor(
        private readonly apiUrl: string,
        private readonly token: string,
        private readonly post: PostLike = (url, init) => fetch(url, init),
    ) {}

    async publish(report: RunReport): Promise<void> {
        const res = await this.post(`${this.apiUrl}/validation/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Validation-Token': this.token },
            body: JSON.stringify(report),
        });
        if (!res.ok) {
            // The body is the API's error message; the token is never part of it
            const detail = (await res.text().catch(() => '')).slice(0, 300);
            throw new PublishError(`Publishing run ${report.id} failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
        }
    }
}
