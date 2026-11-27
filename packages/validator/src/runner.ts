import { randomBytes } from 'crypto';
import { StepFailure } from './types';
import type { DisbursementReceipt, RunReport, StepResult, ValidationStep } from './types';

export interface RunMeta {
    id: string;
    network: RunReport['network'];
    apiUrl: string;
    corridor: string;
    trigger: RunReport['trigger'];
}

export interface RunnerClock {
    now: () => number;
}

const systemClock: RunnerClock = { now: () => Date.now() };

/** `vr_` + 16 random hex chars. Also used as the idempotency-key prefix for the run. */
export function newRunId(): string {
    return `vr_${randomBytes(8).toString('hex')}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Executes `steps` in order against `ctx`. The first failure stops the run and
 * every remaining step is reported as `skipped`, so a report always lists the
 * whole scenario.
 */
export async function runScenario<Ctx extends { orderId?: string; contractId?: string; receipt?: DisbursementReceipt }>(
    steps: ValidationStep<Ctx>[],
    ctx: Ctx,
    meta: RunMeta,
    clock: RunnerClock = systemClock,
): Promise<RunReport> {
    const startedAt = clock.now();
    const results: StepResult[] = [];
    let failed = false;

    for (const step of steps) {
        if (failed) {
            results.push({ name: step.name, status: 'skipped', txHashes: [], confirmations: [], durationMs: 0 });
            continue;
        }
        const t0 = clock.now();
        try {
            const outcome = await step.run(ctx);
            results.push({
                name: step.name,
                status: 'passed',
                txHashes: outcome.txHashes ?? [],
                confirmations: outcome.confirmations ?? [],
                payoutId: outcome.payoutId,
                durationMs: clock.now() - t0,
                details: outcome.details,
            });
        } catch (error: unknown) {
            failed = true;
            const partial = error instanceof StepFailure ? error.partial : {};
            results.push({
                name: step.name,
                status: 'failed',
                txHashes: partial.txHashes ?? [],
                confirmations: partial.confirmations ?? [],
                payoutId: partial.payoutId,
                durationMs: clock.now() - t0,
                error: errorMessage(error),
                details: partial.details,
            });
        }
    }

    const finishedAt = clock.now();
    return {
        ...meta,
        status: failed ? 'failed' : 'passed',
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        orderId: ctx.orderId,
        contractId: ctx.contractId,
        receipt: ctx.receipt,
        steps: results,
    };
}
