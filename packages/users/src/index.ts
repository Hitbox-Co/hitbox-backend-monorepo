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
