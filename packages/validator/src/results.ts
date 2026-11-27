import type { RunReport } from './types';

const EXPLORER = {
    testnet: 'https://stellar.expert/explorer/testnet',
    mainnet: 'https://stellar.expert/explorer/public',
} as const;

/** One finished run, reduced to what the published table shows. */
export interface ResultRow {
    id: string;
    startedAt: string;
    network: 'testnet' | 'mainnet';
    corridor: string;
    status: 'passed' | 'failed';
    durationMs: number;
    trigger: string;
    stepsPassed: number;
    stepsTotal: number;
    failedStep: string | null;
    error: string | null;
    txHashes: string[];
    /** True only when BlindPay itself confirmed the disbursement */
    disbursementVerified: boolean;
}

/** The part of `GET /validation/runs` this needs. */
export interface PublicRunLike {
    id: string;
    startedAt: string;
    network: 'testnet' | 'mainnet';
    corridor: string;
    status: 'passed' | 'failed';
    durationMs: number;
    trigger: string;
    steps: Array<{ name: string; status: string; txHashes: string[]; error?: string }>;
    blindpayStatus: string | null;
}

interface StepLike {
    name: string;
    status: string;
    txHashes: string[];
    error?: string;
}

function summarize(steps: StepLike[]) {
    const failed = steps.find((s) => s.status === 'failed');
    return {
        stepsPassed: steps.filter((s) => s.status === 'passed').length,
        stepsTotal: steps.length,
        failedStep: failed?.name ?? null,
        error: failed?.error ?? null,
        txHashes: steps.flatMap((s) => s.txHashes),
    };
}

export function rowFromReport(report: RunReport): ResultRow {
    return {
        id: report.id,
        startedAt: report.startedAt,
        network: report.network,
        corridor: report.corridor,
        status: report.status,
        durationMs: report.durationMs,
        trigger: report.trigger,
        ...summarize(report.steps),
        disbursementVerified: report.receipt?.status === 'completed',
    };
}

export function rowFromPublicRun(run: PublicRunLike): ResultRow {
    return {
        id: run.id,
        startedAt: run.startedAt,
        network: run.network,
        corridor: run.corridor,
        status: run.status,
        durationMs: run.durationMs,
        trigger: run.trigger,
        ...summarize(run.steps),
        disbursementVerified: run.blindpayStatus === 'completed',
    };
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds} s`;
    return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** Table cells must not break the row. */
function cell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/**
 * The published record of the end-to-end runs: a summary and one row per run,
 * newest first, each linking its transactions on Stellar Expert.
 */
export function renderResults(rows: ResultRow[], generatedAt: Date): string {
    const sorted = [...rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const passed = sorted.filter((r) => r.status === 'passed');
    const verifiedCorridors = [...new Set(sorted.filter((r) => r.status === 'passed' && r.disbursementVerified).map((r) => r.corridor))].sort();
    const mainnet = sorted.filter((r) => r.network === 'mainnet');

    const lines: string[] = [
        '# End-to-end validation results',
        '',
        `Generated ${generatedAt.toISOString()} from the validation runner (\`apps/validator\`).`,
        '',
        '| | |',
        '|---|---|',
        `| Runs | ${sorted.length} (${mainnet.length} on mainnet) |`,
        `| Passed | ${passed.length} |`,
        `| Failed | ${sorted.length - passed.length} |`,
        `| Corridors with a BlindPay-verified disbursement | ${verifiedCorridors.length > 0 ? verifiedCorridors.join(', ') : 'none yet'} |`,
        '',
    ];

    if (sorted.length === 0) {
        lines.push('No runs recorded yet.', '');
        return lines.join('\n');
    }

    lines.push(
        '| Started (UTC) | Network | Corridor | Result | Steps | Duration | Disbursement | Trigger | Run |',
        '|---|---|---|---|---|---|---|---|---|',
    );
    for (const r of sorted) {
        const result = r.status === 'passed' ? '✅ passed' : `❌ failed at \`${r.failedStep ?? 'unknown'}\``;
        const first = r.txHashes[0];
        const run = first ? `[${r.id}](${EXPLORER[r.network]}/tx/${first})` : r.id;
        lines.push(
            `| ${r.startedAt.replace('T', ' ').slice(0, 19)} | ${r.network} | ${r.corridor} | ${cell(result)} | ${r.stepsPassed}/${r.stepsTotal} | ${formatDuration(r.durationMs)} | ${r.disbursementVerified ? 'verified by BlindPay' : '—'} | ${r.trigger} | ${run} |`,
        );
    }

    const failures = sorted.filter((r) => r.status === 'failed' && r.error);
    if (failures.length > 0) {
        lines.push('', '## Failures', '');
        for (const r of failures) {
            lines.push(`- \`${r.id}\` (${r.corridor}, \`${r.failedStep}\`): ${cell(r.error ?? '')}`);
        }
    }

    lines.push('');
    return lines.join('\n');
}
