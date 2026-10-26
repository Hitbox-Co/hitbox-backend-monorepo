/**
 * Sends the invitation that lets a vendor's staff member set a password and
 * sign in, as a port.
 *
 * Implemented at the bootstrap boundary on top of the staff-invitation
 * service, so vendor sign-up is the same flow as every other invited account
 * (identity-provider email → sign-up → role granted on
 * `users.account.provisioned`) and this module never imports access-control.
 */
export interface VendorInvitationResult {
    /** The StaffInvitation row carrying the VENDOR role. */
    invitationId: string;
    /**
     * Set when the address already had an account: the role was granted on the
     * spot and there is nothing to accept.
     */
    userId: string | null;
    outcome: 'ROLE_ASSIGNED' | 'INVITATION_SENT';
    expiresAt: Date;
}

export interface IVendorInvitations {
    invite(input: {
        email: string;
        invitedById: string;
        /** The inviter's own permission keys — the no-escalation check needs them. */
        inviterPermissions: string[];
    }): Promise<VendorInvitationResult>;
    /** Withdraws an unclaimed invitation. Must not throw for one already accepted. */
    revoke(input: { invitationId: string; revokedById: string; reason: string }): Promise<void>;
}

/** The payload of `access-control.staff.invitation-accepted`, structurally. */
export interface StaffInvitationAcceptedEvent {
    invitationId: string;
    email: string;
    userId: string;
}
