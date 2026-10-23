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
export { ARTIST_GENRES } from './self/constants/artist-self.constant';
export type { IArtistImageStorage } from './self/domain/artist-image-storage.interface';
export type { MyArtistProfile } from './self/service/artist-self.service';

// Artist collections — docs/artist-collection/.
export {
    ACTIVE_DROP_WHERE,
    ARTIST_AUDIT_EVENTS,
    ARTIST_COLLECTION_ERROR_CODES,
    ARTIST_COLLECTION_EVENTS,
    MAX_LIVE_COLLECTIONS_PER_ARTIST,
} from './collection/constants/artist-collection.constant';
export {
    adminListCollectionsQuerySchema,
    createCollectionSchema,
    reorderCollectionsSchema,
    restoreCollectionSchema,
    updateCollectionSchema,
} from './collection/dto/artist-collection.dto';
export type {
    AdminCollectionDetailView,
    AdminCollectionView,
    CollectionSummaryView,
    ArtistDropView,
    CollectionView,
    MyCollectionDetailView,
    MyCollectionView,
} from './collection/dto/artist-collection.dto';

// The audit hook — bootstrap passes the real recorder in.
export { NOOP_ARTIST_AUDIT } from './domain/interfaces/audit-recorder.port';
export type { ArtistAuditRecordInput, IArtistAuditRecorder } from './domain/interfaces/audit-recorder.port';
