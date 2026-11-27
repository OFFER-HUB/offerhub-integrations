import { formatDuration, renderResults, rowFromPublicRun, rowFromReport, type ResultRow } from '../results';
import type { RunReport } from '../types';

const NOW = new Date('2026-11-25T10:00:00Z');

function report(overrides: Partial<RunReport> = {}): RunReport {
    return {
        id: 'run_1',
        network: 'mainnet',
        apiUrl: 'https://api.example.test',
        corridor: 'MX',
        trigger: 'manual',
        status: 'passed',
        startedAt: '2026-11-25T09:00:00.000Z',
        finishedAt: '2026-11-25T09:20:00.000Z',
        durationMs: 1_200_000,
        receipt: { status: 'completed' } as never,
        steps: [
            { name: 'authenticate', status: 'passed', txHashes: [], confirmations: [], durationMs: 10 },
            { name: 'escrow_create', status: 'passed', txHashes: ['aaa'], confirmations: [], durationMs: 10 },
            { name: 'escrow_fund', status: 'passed', txHashes: ['bbb'], confirmations: [], durationMs: 10 },
        ],
        ...overrides,
    };
}

function row(overrides: Partial<ResultRow> = {}): ResultRow {
    return { ...rowFromReport(report()), ...overrides };
}

describe('formatDuration', () => {
    it.each([
        [450, '450 ms'],
        [42_000, '42 s'],
        [1_200_000, '20 min 0 s'],
        [95_000, '1 min 35 s'],
    ])('%i ms → %s', (ms, text) => expect(formatDuration(ms)).toBe(text));
});

describe('rowFromReport', () => {
    it('counts steps, collects transactions and reads the disbursement from the receipt', () => {
        const r = rowFromReport(report());
        expect(r).toMatchObject({ stepsPassed: 3, stepsTotal: 3, failedStep: null, txHashes: ['aaa', 'bbb'], disbursementVerified: true });
    });

    it('names the failed step and its error, and is not verified without a receipt', () => {
        const r = rowFromReport(
            report({
                status: 'failed',
                receipt: undefined,
                steps: [
                    { name: 'authenticate', status: 'passed', txHashes: [], confirmations: [], durationMs: 1 },
                    { name: 'escrow_fund', status: 'failed', txHashes: [], confirmations: [], durationMs: 1, error: 'insufficient USDC' },
                    { name: 'escrow_release', status: 'skipped', txHashes: [], confirmations: [], durationMs: 0 },
                ],
            }),
        );
        expect(r).toMatchObject({ stepsPassed: 1, stepsTotal: 3, failedStep: 'escrow_fund', error: 'insufficient USDC', disbursementVerified: false });
    });
});

describe('rowFromPublicRun', () => {
    it('maps the public API shape, verified only when BlindPay confirmed', () => {
        const base = {
            id: 'run_2', startedAt: '2026-11-25T09:00:00.000Z', network: 'mainnet' as const, corridor: 'BR',
            status: 'passed' as const, durationMs: 5000, trigger: 'schedule',
            steps: [{ name: 'a', status: 'passed', txHashes: ['h1'] }],
        };
        expect(rowFromPublicRun({ ...base, blindpayStatus: 'completed' }).disbursementVerified).toBe(true);
        expect(rowFromPublicRun({ ...base, blindpayStatus: null }).disbursementVerified).toBe(false);
    });
});

describe('renderResults', () => {
    it('says so when nothing ran yet, without a table', () => {
        const md = renderResults([], NOW);
        expect(md).toContain('No runs recorded yet.');
        expect(md).toContain('| Runs | 0 (0 on mainnet) |');
        expect(md).not.toContain('| Started (UTC)');
    });

    it('summarises runs, lists them newest first and links the first transaction on the right network', () => {
        const md = renderResults(
            [
                row({ id: 'old', startedAt: '2026-11-24T09:00:00.000Z', network: 'testnet', corridor: 'BR', txHashes: ['t1'] }),
                row({ id: 'new', startedAt: '2026-11-25T09:00:00.000Z', corridor: 'MX' }),
            ],
            NOW,
        );
        expect(md).toContain('| Runs | 2 (1 on mainnet) |');
        expect(md.indexOf('[new]')).toBeLessThan(md.indexOf('[old]'));
        expect(md).toContain('[new](https://stellar.expert/explorer/public/tx/aaa)');
        expect(md).toContain('[old](https://stellar.expert/explorer/testnet/tx/t1)');
        expect(md).toContain('2026-11-25 09:00:00');
        expect(md).toContain('20 min 0 s');
    });

    it('lists only corridors whose passed run was verified by BlindPay', () => {
        const md = renderResults(
            [
                row({ id: 'a', corridor: 'MX' }),
                row({ id: 'b', corridor: 'BR' }),
                row({ id: 'c', corridor: 'CO', disbursementVerified: false }),
                row({ id: 'd', corridor: 'AR', status: 'failed', failedStep: 'x' }),
            ],
            NOW,
        );
        expect(md).toContain('| Corridors with a BlindPay-verified disbursement | BR, MX |');
    });

    it('shows failures with their step and error, and escapes table-breaking characters', () => {
        const md = renderResults(
            [row({ id: 'bad', status: 'failed', failedStep: 'escrow_fund', error: 'a | b\nsecond line', txHashes: [] })],
            NOW,
        );
        expect(md).toContain('❌ failed at `escrow_fund`');
        expect(md).toContain('## Failures');
        expect(md).toContain('a \\| b second line');
        expect(md).toContain('| bad |');
    });
});
