/** Mirrors the Prisma `AuditResult` enum. */
export enum AuditResult {
    SUCCESS = 'SUCCESS',
    FAILURE = 'FAILURE',
    /** An authorization refusal. Kept distinct so it can be alerted on. */
    DENIED = 'DENIED',
}

/** Who initiated an audited action. Stored as a plain string column. */
export enum AuditActorType {
    USER = 'USER',
    SYSTEM = 'SYSTEM',
    WEBHOOK = 'WEBHOOK',
}
