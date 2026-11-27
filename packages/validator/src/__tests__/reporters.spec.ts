import { ApiReporter, PublishError, neverStarted } from '../reporters';
import type { RunReport } from '../types';

const report = { id: 'vr_0123456789abcdef', corridor: 'MX', steps: [] } as unknown as RunReport;

describe('ApiReporter', () => {
    it('posts the run to the public results endpoint with the runner token', async () => {
        const post = jest.fn(async () => ({ ok: true, status: 201, text: async () => '' }));
        await new ApiReporter('https://api.example/api/v1', 'runner-token', post).publish(report);
        expect(post).toHaveBeenCalledWith('https://api.example/api/v1/validation/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Validation-Token': 'runner-token' },
            body: JSON.stringify(report),
        });
    });

    it('fails loudly, without echoing the token, when the API refuses the run', async () => {
        const post = async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"Invalid validation token"}}' });
        const error = await new ApiReporter('https://api.example/api/v1', 'runner-token', post).publish(report).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PublishError);
        expect((error as Error).message).toMatch(/HTTP 401: .*Invalid validation token/);
        expect((error as Error).message).not.toContain('runner-token');
    });

    it('does not publish a run that failed at preflight, because nothing was tested', async () => {
        const post = jest.fn(async () => ({ ok: true, status: 201, text: async () => '' }));
        const refused = {
            id: 'vr_refused000000000',
            corridor: 'MX',
            steps: [
                { name: 'preflight', status: 'failed' },
                { name: 'authenticate', status: 'skipped' },
            ],
        } as unknown as RunReport;

        await new ApiReporter('https://api.example/api/v1', 'runner-token', post).publish(refused);

        expect(neverStarted(refused)).toBe(true);
        expect(post).not.toHaveBeenCalled();
    });

    it('still publishes a run that failed after it started', async () => {
        const post = jest.fn(async () => ({ ok: true, status: 201, text: async () => '' }));
        const failedLater = {
            id: 'vr_failedlater00000',
            corridor: 'MX',
            steps: [
                { name: 'preflight', status: 'passed' },
                { name: 'escrow_fund', status: 'failed' },
            ],
        } as unknown as RunReport;

        await new ApiReporter('https://api.example/api/v1', 'runner-token', post).publish(failedLater);

        expect(neverStarted(failedLater)).toBe(false);
        expect(post).toHaveBeenCalledTimes(1);
    });
});
