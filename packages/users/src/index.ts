// Module factory
export { createUsersModule } from './module';
export type { UsersModule, UsersModuleDeps } from './module';

// Constants
export { USERS_ERROR_CODES, USERS_MODULE } from './constants/users.constant';

// DTOs
export { updateProfileSchema } from './dto/user.dto';
export type { MeDto, PublicUserDto, UpdateProfileDto } from './dto/user.dto';

// Service type (for other modules that receive it via DI)
export type { UserService } from './service/user.service';

// Events this module publishes.
export { USERS_EVENTS } from './constants/users.constant';
export type { AccountProvisionedPayload } from './events/users-event.payloads';
