// Module factory
export { createAuthModule } from './module';
export type { AuthModule, AuthModuleDeps } from './module';

// Constants
export {
    AUTH_ERROR_CODES,
    AUTH_EVENTS,
    AUTH_MODULE,
    CLERK_WEBHOOK_PATH,
    HANDLED_CLERK_EVENTS,
    WEBHOOK_EVENT_RETENTION_DAYS,
} from './constants/auth.constant';
export type { AuthEventName } from './constants/auth.constant';

// Domain
export { AccountStatus } from './domain/enums/account-status.enum';
export { UserRole, isUserRole } from './domain/enums/user-role.enum';
export type {
    AccountSnapshot,
    IAccountLookup,
} from './domain/interfaces/account-lookup.interface';

// Event payload contracts
export type {
    UserDeletedPayload,
    UserRegisteredPayload,
    UserUpdatedPayload,
} from './events/auth-event.payloads';

// Types
export type { AuthContext } from './types/auth.types';
