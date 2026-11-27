/**
 * Lifecycle of an escrow as the adapter reports it. Plain string values, so an
 * application can store them or compare them with its own enum of the same names.
 */
export const EscrowStatus = {
    CREATING: 'CREATING',
    CREATED: 'CREATED',
    FUNDING: 'FUNDING',
    FUNDED: 'FUNDED',
    RELEASING: 'RELEASING',
    RELEASED: 'RELEASED',
    REFUNDING: 'REFUNDING',
    REFUNDED: 'REFUNDED',
    DISPUTED: 'DISPUTED',
} as const;

export type EscrowStatus = (typeof EscrowStatus)[keyof typeof EscrowStatus];
