#!/usr/bin/env node
/**
 * Blank-project install test for the two API adapters (#325).
 *
 * Packs both packages exactly as npm would publish them, installs the tarballs
 * into a throwaway NestJS project that has nothing to do with this monorepo,
 * compiles the README examples with a strict TypeScript config, boots a Nest
 * app with both modules, and exercises the clients:
 *
 *   - Trustless Work: the config guards, and a real read from Stellar testnet RPC
 *   - BlindPay: a quote, a payout lookup and the error mapping, against a local HTTPS stub
 *
 *   npm run check:blank-project
 *
 * Needs network access to the npm registry and to the Soroban testnet RPC, and `openssl`.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['adapter-trustlesswork', 'adapter-blindpay'];
const work = mkdtempSync(path.join(tmpdir(), 'offerhub-blank-'));
const packs = path.join(work, 'packs');
const app = path.join(work, 'app');

function run(command, cwd, env = {}) {
    execSync(command, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
}

/** The first ```ts block of a README that follows the given heading. */
function readmeExamples(pkg) {
    const text = readFileSync(path.join(root, 'packages', pkg, 'README.md'), 'utf8');
    return [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
}

try {
    mkdirSync(packs);
    mkdirSync(app);

    for (const pkg of packages) {
        run(`npm run build -w @offerhub-orchestrator/${pkg}`, root);
        run(`npm pack --pack-destination "${packs}"`, path.join(root, 'packages', pkg));
    }
    const tarballs = readdirSync(packs).filter((f) => f.endsWith('.tgz')).map((f) => path.join(packs, f));
    if (tarballs.length !== packages.length) throw new Error(`Expected ${packages.length} tarballs, got ${tarballs.length}`);

    writeFileSync(
        path.join(app, 'package.json'),
        JSON.stringify({ name: 'offerhub-blank-project-check', version: '1.0.0', private: true }, null, 2),
    );
    // Exactly what each README tells a newcomer to install, run in the order it says it
    const installs = packages.flatMap((pkg) => {
        const text = readFileSync(path.join(root, 'packages', pkg, 'README.md'), 'utf8');
        const block = text.match(/```bash\n([\s\S]*?)```/)?.[1] ?? '';
        return block.split('\n').filter((l) => l.startsWith('npm install') && !l.includes('@offerhub-orchestrator/adapter'));
    });
    if (installs.length === 0) throw new Error('No install command found in the READMEs');
    // What the READMEs leave to the project itself: the Nest runtime and the TypeScript toolchain
    run('npm install --no-audit --no-fund @nestjs/core@^10 @nestjs/platform-express@^10 rxjs typescript@^5 @types/node@^20', app);
    for (const line of installs) run(`${line} --no-audit --no-fund`, app);
    run(`npm install --no-audit --no-fund ${tarballs.map((t) => `"${t}"`).join(' ')}`, app);

    writeFileSync(
        path.join(app, 'tsconfig.json'),
        JSON.stringify(
            {
                compilerOptions: {
                    target: 'ES2021',
                    module: 'commonjs',
                    moduleResolution: 'node',
                    strict: true,
                    esModuleInterop: true,
                    experimentalDecorators: true,
                    emitDecoratorMetadata: true,
                    skipLibCheck: true, // Nest's own default
                    outDir: 'dist',
                },
                include: ['src'],
            },
            null,
            2,
        ),
    );
    mkdirSync(path.join(app, 'src'));

    // The README examples, compiled as written
    const [twExample] = readmeExamples('adapter-trustlesswork').slice(1, 2);
    const bpExamples = readmeExamples('adapter-blindpay');
    writeFileSync(
        path.join(app, 'src', 'readme-trustlesswork.ts'),
        `import { CreateEscrowDto } from '@offerhub-orchestrator/adapter-trustlesswork';\n${twExample}`,
    );
    writeFileSync(path.join(app, 'src', 'readme-blindpay.ts'), `import 'reflect-metadata';\n${bpExamples[1]}`);

    copyFileSync(path.join(root, 'scripts', 'blank-project', 'main.ts'), path.join(app, 'src', 'main.ts'));

    run('npx tsc -p tsconfig.json', app);

    // The same compile with library checks on: our packages' type declarations must be clean.
    // (Stellar's own declarations need @types/urijs; that is theirs, not ours.)
    try {
        execSync('npx tsc -p tsconfig.json --noEmit --skipLibCheck false', { cwd: app, stdio: 'pipe' });
    } catch (error) {
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        const ours = output.split('\n').filter((l) => /@offerhub\/adapter|^src\//.test(l));
        if (ours.length > 0) throw new Error(`Type errors in the adapters or the examples:\n${ours.join('\n')}`);
        console.log('Strict compile: only third-party declaration errors, none from the adapters');
    }

    // A self-signed certificate for the BlindPay stub (BlindPay's base URL must be https)
    run(
        'openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj "/CN=localhost" ' +
            '-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"',
        app,
    );
    run('node dist/main.js', app, { NODE_EXTRA_CA_CERTS: path.join(app, 'cert.pem') });

    console.log('\nBlank-project check passed.');
} finally {
    if (!process.env.KEEP_BLANK_PROJECT) rmSync(work, { recursive: true, force: true });
    else console.log(`Kept ${work}`);
}
