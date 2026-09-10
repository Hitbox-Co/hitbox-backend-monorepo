/**
 * @hitbox/payments
 *
 * Payment gateway transactions, gateway config, webhook deliveries and refunds.
 *
 * Schema-only at this stage: this module owns its Prisma partial under
 * ./prisma, which shared/database merges into the generated schema. The
 * repository / service / controller layers land here as the feature is
 * built — see docs/database-architecture.md for the ownership map.
 */
export const MODULE_NAME = "payments" as const;
