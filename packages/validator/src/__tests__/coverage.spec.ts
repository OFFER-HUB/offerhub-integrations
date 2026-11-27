import { summarizeCoverage } from '../coverage';
import type { DisbursementReceipt, RunReport } from '../types';

function run(corridor: string, status: RunReport['status'], withReceipt = status === 'passed'): RunReport {
    return {
        id: `vr_${corridor}`,
        network: 'mainnet',
        apiUrl: 'https://api',
        corridor,
        trigger: 'manual',
        status,
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        receipt: withReceipt ? ({ corridor, blindpayPayoutId: `po_${corridor}` } as DisbursementReceipt) : undefined,
        steps: [],
    };
}

describe('summarizeCoverage', () => {
    it('passes once enough distinct corridors have a verified receipt', () => {
        const s = summarizeCoverage([run('MX', 'passed'), run('BR', 'passed'), run('CO', 'passed'), run('AR', 'failed')], 3, 'now');
        expect(s.covered).toEqual(['BR', 'CO', 'MX']);
        expect(s.passed).toBe(true);
        expect(s.runs.find((r) => r.corridor === 'AR')).toMatchObject({ status: 'failed', receipt: null });
    });

    it('does not count failed runs or runs without a BlindPay receipt', () => {
        const s = summarizeCoverage([run('MX', 'passed'), run('BR', 'failed'), run('CO', 'passed', false)], 3, 'now');
        expect(s.covered).toEqual(['MX']);
        expect(s.passed).toBe(false);
    });

    it('requires nothing when no minimum is set', () => {
        expect(summarizeCoverage([run('MX', 'failed')], 0, 'now').passed).toBe(true);
    });
});
