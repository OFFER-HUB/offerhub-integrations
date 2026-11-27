import { BaseResource } from './base';
import type { CreateUserRequest, User } from '../types';

/**
 * Marketplace users. Requires an API key.
 */
export class UsersResource extends BaseResource {
    /**
     * Creates a user with a balance record. Idempotent by `externalUserId`:
     * creating the same one again returns the existing user.
     *
     * @example
     * ```typescript
     * const user = await sdk.users.create({ externalUserId: 'user_123', email: 'ana@example.com', type: 'SELLER' });
     * ```
     */
    async create(data: CreateUserRequest): Promise<User> {
        return this.http.request<User>('POST', 'users', { body: data });
    }
}
