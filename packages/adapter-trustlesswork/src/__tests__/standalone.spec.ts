import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/** Every .ts file of the package's own source, tests included. */
function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    });
}

describe('@offerhub-orchestrator/adapter-trustlesswork stays standalone', () => {
    const files = sourceFiles(join(__dirname, '..'));
    const importsOf = (file: string) =>
        [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

    it('finds the source files', () => {
        expect(files.length).toBeGreaterThan(10);
    });

    it('imports nothing from another OfferHub package or from the apps', () => {
        const offenders = files.flatMap((file) =>
            importsOf(file)
                .filter((spec) => spec.startsWith('@offerhub/') || /apps\/|packages\//.test(spec) || /@prisma\//.test(spec))
                .map((spec) => `${file}: ${spec}`),
        );
        expect(offenders).toEqual([]);
    });

    it('never reaches outside its own folder with a relative import', () => {
        const root = join(__dirname, '..');
        const offenders = files.flatMap((file) =>
            importsOf(file)
                .filter((spec) => spec.startsWith('.'))
                .filter((spec) => !join(file, '..', spec).startsWith(root))
                .map((spec) => `${file}: ${spec}`),
        );
        expect(offenders).toEqual([]);
    });
});
