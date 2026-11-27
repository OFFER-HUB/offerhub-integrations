import type { DisbursementReceipt, RunReport } from './types';

/**
 * Corridor coverage across one invocation of the runner (#317).
 *
 * SCF's bar for D3.3 is a verified disbursement in at least three LATAM
 * corridors. A corridor counts only when its run passed end to end and carries
 * a BlindPay receipt.
 */
export interface CoverageSummary {
    generatedAt: string;
    network: RunReport['network'];
    required: number;
    covered: string[];
    passed: boolean;
    runs: Array<{ runId: string; corridor: string; status: RunReport['status']; receipt: DisbursementReceipt | null }>;
}

export function summarizeCoverage(reports: RunReport[], required: number, generatedAt: string): CoverageSummary {
    const covered = [...new Set(reports.filter((r) => r.status === 'passed' && r.receipt).map((r) => r.corridor))].sort();
    return {
        generatedAt,
        network: reports[0]?.network ?? 'mainnet',
        required,
        covered,
        passed: covered.length >= required,
        runs: reports.map((r) => ({ runId: r.id, corridor: r.corridor, status: r.status, receipt: r.receipt ?? null })),
    };
}
