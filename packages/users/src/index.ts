// Module factory
export { createUsersModule } from './module';
export type { UsersModule, UsersModuleDeps } from './module';

// Constants
export { USERS_ERROR_CODES, USERS_MODULE } from './constants/users.constant';

// Event contract — consumed by @hitbox/authz
export { USERS_EVENTS } from './events/users-event.payloads';
export type {
    UserDeactivatedPayload,
    UserProvisionedPayload,
    UsersEventName,
} from './events/users-event.payloads';

// Authorization port implementation (structurally satisfies authz IUserDirectory)
export { UserDirectory } from './domain/user-directory.adapter';
export type { DirectoryUser } from './domain/user-directory.adapter';

// DTOs
export { updateProfileSchema } from './dto/user.dto';
export type { MeDto, PublicUserDto, UpdateProfileDto } from './dto/user.dto';

// Service type (for other modules that receive it via DI)
export type { UserService } from './service/user.service';
