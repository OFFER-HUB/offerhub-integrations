import { ApiReporter, PublishError } from '../reporters';
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
});
