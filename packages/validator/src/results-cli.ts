#!/usr/bin/env tsx
/**
 * Renders the end-to-end results as markdown.
 *
 *   npm run validation:results -- --dir validation-reports [--out docs/validation/results.md]
 *   npm run validation:results -- --api https://api.example.com/api/v1 [--out ...]
 *
 * `--dir` reads the JSON reports a run wrote; `--api` reads the public
 * `GET /validation/runs`. Without `--out` it prints to stdout.
 */
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { renderResults, rowFromPublicRun, rowFromReport, type PublicRunLike, type ResultRow } from './results';
import type { RunReport } from './types';

async function fromDir(dir: string): Promise<ResultRow[]> {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const rows: ResultRow[] = [];
    for (const file of files) {
        const report = JSON.parse(await readFile(join(dir, file), 'utf8')) as RunReport;
        if (report.id && Array.isArray(report.steps)) rows.push(rowFromReport(report));
    }
    return rows;
}

async function fromApi(baseUrl: string): Promise<ResultRow[]> {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/validation/runs?limit=100`);
    if (!response.ok) throw new Error(`GET /validation/runs answered ${response.status}`);
    const body = (await response.json()) as { data?: PublicRunLike[] } | PublicRunLike[];
    const runs = Array.isArray(body) ? body : (body.data ?? []);
    return runs.map(rowFromPublicRun);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const value = (flag: string) => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const dir = value('--dir');
    const api = value('--api');
    if ((dir && api) || (!dir && !api)) throw new Error('Pass exactly one of --dir or --api');

    const rows = dir ? await fromDir(dir) : await fromApi(api as string);
    const markdown = renderResults(rows, new Date());

    const out = value('--out');
    if (out) {
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, markdown);
        console.log(`Wrote ${rows.length} run(s) to ${out}`);
    } else {
        console.log(markdown);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
