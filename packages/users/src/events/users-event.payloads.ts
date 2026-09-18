/**
 * Payload contracts for USERS_EVENTS. Subscribers import these types.
 */

export interface AccountProvisionedPayload {
    /** The local `User.id`. Guaranteed to exist when this event is published. */
    userId: string;
    /** As stored on the row, which is what an invitation is matched against. */
    email: string;
    clerkUserId: string;
}
