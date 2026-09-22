// Module factory
export { createArtistModule } from './module';
export type {
    ArtistModule,
    ArtistModuleDeps,
    ArtistPermissionGuard,
} from './module';

// Ports this module provides to others.
export { ArtistOwnershipAdapter } from './adapter/artist-ownership.adapter';

// Constants
export { ARTIST_MODULE } from './collection/constants/artist-collection.constant';
export {
    ARTIST_READ_CAPABILITY,
    ARTIST_PROFILE_ERROR_CODES,
} from './profile/constants/artist-profile.constant';

// The artist directory — backs the drop form's artist picker.
export { listArtistsQuerySchema } from './profile/dto/artist.dto';
export type { ArtistResponse, ListArtistsQuery } from './profile/dto/artist.dto';
export type { ArtistService } from './profile/service/artist.service';

// Invited artists get a profile. Exported for tests and backfills; the running
// app drives this through the event subscriptions the module factory sets up.
export { ArtistProvisioningService } from './profile/service/artist-provisioning.service';
export type {
    StaffInvitationAcceptedEvent,
    StaffInvitedEvent,
} from './profile/service/artist-provisioning.service';
export { nameFromEmail, roleImpliesArtistProfile, slugify } from './profile/domain/artist-role';
