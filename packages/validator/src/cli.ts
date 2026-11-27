#!/usr/bin/env tsx
/**
 * Live Production Validation Framework — CLI (issue #315).
 *
 *   npm run validate -- [--corridor MX] [--preflight-only | --escrow-only] [--out reports/] [--trigger schedule] [--min-corridors 3]
 *
 * Runs the escrow → fiat scenario once per configured corridor (or only the one
 * given), one after another, and exits non-zero if any run failed or if fewer
 * than --min-corridors corridors ended with a verified BlindPay receipt (#317).
 * Configuration: see apps/validator/README.md.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { OfferHubSDK } from '@offerhub/sdk';
import { HttpBlindPayReader } from './blindpay';
import { ConfigError, loadConfig, type ValidationConfig } from './config';
import { summarizeCoverage } from './coverage';
import { RpcLedgerReader } from './ledger';
import { ApiReporter, ConsoleReporter, JsonFileReporter } from './reporters';
import { newRunId, runScenario } from './runner';
import { ESCROW_TO_FIAT_SCENARIO, type ScenarioContext } from './scenario';
import type { Reporter, RunReport } from './types';

interface CliArgs {
    corridor?: string;
    preflightOnly: boolean;
    escrowOnly: boolean;
    out?: string;
    trigger: RunReport['trigger'];
    minCorridors: number;
}

function parseArgs(argv: string[]): CliArgs {
    const value = (flag: string) => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const trigger = value('--trigger') ?? 'manual';
    if (trigger !== 'manual' && trigger !== 'schedule') throw new ConfigError('--trigger must be "manual" or "schedule"');
    const minRaw = value('--min-corridors') ?? '0';
    const minCorridors = Number(minRaw);
    if (!Number.isInteger(minCorridors) || minCorridors < 0) throw new ConfigError('--min-corridors must be a non-negative integer');
    const preflightOnly = argv.includes('--preflight-only');
    const escrowOnly = argv.includes('--escrow-only');
    if (preflightOnly && escrowOnly) throw new ConfigError('--preflight-only and --escrow-only are mutually exclusive');
    // An escrow-only run never reaches BlindPay, so it can't produce a receipt
    if (escrowOnly && minCorridors > 0) throw new ConfigError('--escrow-only cannot be combined with --min-corridors');
    return {
        corridor: value('--corridor'),
        preflightOnly,
        escrowOnly,
        out: value('--out'),
        trigger,
        minCorridors,
    };
}

/**
 * --escrow-only stops after the escrow is released, before any BlindPay step:
 * it proves the TrustlessWork side on its own (e.g. the first mainnet escrow,
 * #312) with a seller who has no approved KYC or bank account yet.
 */
function selectSteps(args: CliArgs): typeof ESCROW_TO_FIAT_SCENARIO {
    if (args.preflightOnly) return ESCROW_TO_FIAT_SCENARIO.slice(0, 1);
    if (args.escrowOnly) {
        const releaseIndex = ESCROW_TO_FIAT_SCENARIO.findIndex((step) => step.name === 'escrow_release');
        return ESCROW_TO_FIAT_SCENARIO.slice(0, releaseIndex + 1);
    }
    return ESCROW_TO_FIAT_SCENARIO;
}

let publishFailures = 0;

async function runOnce(config: ValidationConfig, sellerIndex: number, args: CliArgs, reporters: Reporter[]): Promise<RunReport> {
    const seller = config.sellers[sellerIndex];
    const runId = newRunId();
    const ctx: ScenarioContext = {
        runId,
        corridor: seller.corridor,
        amountUsdc: config.amountUsdc,
        minBalanceUsdc: config.minBalanceUsdc,
        networkPassphrase: config.networkPassphrase,
        buyerKeypair: config.buyer,
        sellerKeypair: seller.keypair,
        api: new OfferHubSDK({ apiUrl: config.apiUrl, timeout: 60_000 }),
        ledger: new RpcLedgerReader(config.rpcUrl, config.usdcAssetCode, config.usdcIssuer),
        // Escrow-only runs stop before any BlindPay step, so there is no reader to build
        blindpay: config.blindpay
            ? new HttpBlindPayReader(config.blindpay.baseUrl, config.blindpay.instanceId, config.blindpay.apiKey)
            : { getPayout: () => Promise.reject(new Error('BlindPay is not configured for an escrow-only run')) },
        payoutTimeoutMs: config.payoutTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        confirmTimeoutMs: config.confirmTimeoutMs,
        confirmPollIntervalMs: config.confirmPollIntervalMs,
        sleep: (ms) => sleep(ms).then(() => undefined),
        now: () => Date.now(),
    };
    const steps = selectSteps(args);
    const report = await runScenario(steps, ctx, {
        id: runId,
        network: config.network,
        apiUrl: config.apiUrl,
        corridor: seller.corridor,
        trigger: args.trigger,
    });
    for (const reporter of reporters) {
        try {
            await reporter.publish(report);
        } catch (error: unknown) {
            // One broken destination must not hide the run from the others; it still fails the invocation
            publishFailures++;
            console.error(`Reporter ${reporter.constructor.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return report;
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    const config = loadConfig(process.env, { escrowOnly: args.escrowOnly });

    // An escrow-only run proves OfferHub's own flow, not a bank corridor: one escrow is enough,
    // so without --corridor it uses the first configured seller instead of one run per seller
    const indexes = config.sellers
        .map((s, i) => ({ corridor: s.corridor, i }))
        .filter((s) => !args.corridor || s.corridor === args.corridor)
        .map((s) => s.i)
        .slice(0, args.escrowOnly && !args.corridor ? 1 : undefined);
    if (indexes.length === 0) throw new ConfigError(`No seller configured for corridor ${args.corridor}`);

    const reporters: Reporter[] = [new ConsoleReporter()];
    if (args.out) reporters.push(new JsonFileReporter(args.out));
    // Preflight-only runs move nothing and aren't results worth publishing
    if (config.publishToken && !args.preflightOnly) reporters.push(new ApiReporter(config.apiUrl, config.publishToken));
    else if (!args.preflightOnly) console.warn('VALIDATION_PUBLISH_TOKEN is not set: results will not be published to the stats endpoint');

    if (!args.preflightOnly && args.minCorridors > indexes.length) {
        throw new ConfigError(`--min-corridors ${args.minCorridors} needs at least that many corridors; ${indexes.length} selected`);
    }

    const reports: RunReport[] = [];
    // Sequential on purpose: every run spends from the same buyer wallet
    for (const i of indexes) reports.push(await runOnce(config, i, args, reporters));
    const failures = reports.filter((r) => r.status === 'failed').length;
    if (args.preflightOnly) return failures === 0 && publishFailures === 0 ? 0 : 1;

    const coverage = summarizeCoverage(reports, args.minCorridors, new Date().toISOString());
    console.log(
        `\nCorridor coverage: ${coverage.covered.length}/${coverage.required || coverage.runs.length} verified` +
            ` (${coverage.covered.join(', ') || 'none'})${coverage.passed ? '' : ' — BELOW THE REQUIRED MINIMUM'}`,
    );
    if (args.out) {
        await mkdir(args.out, { recursive: true });
        await writeFile(join(args.out, `coverage-${reports[0].id}.json`), `${JSON.stringify(coverage, null, 2)}\n`);
    }
    return failures === 0 && publishFailures === 0 && coverage.passed ? 0 : 1;
}

main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
        console.error(error instanceof ConfigError ? `Configuration error: ${error.message}` : error);
        process.exit(2);
    });
