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
    addDropsSchema,
    availableDropsQuerySchema,
    reorderCollectionsSchema,
    restoreCollectionSchema,
    updateCollectionSchema,
} from './collection/dto/artist-collection.dto';
export type {
    AdminCollectionDetailView,
    AdminCollectionView,
    CollectionSummaryView,
    AddDropProblem,
    ArtistDropView,
    AvailableDropView,
    DropMembershipResult,
    CollectionView,
    MyCollectionDetailView,
    MyCollectionView,
} from './collection/dto/artist-collection.dto';

// Drops in collections — the port products implements.
export type { IDropCollectionMembership, MembershipDrop } from './collection/domain/drop-membership.port';

// The audit hook — bootstrap passes the real recorder in.
export { NOOP_ARTIST_AUDIT } from './domain/interfaces/audit-recorder.port';
export type { ArtistAuditRecordInput, IArtistAuditRecorder } from './domain/interfaces/audit-recorder.port';

// Staff administration of artists — docs/artist/artist-admin-api.md.
export {
    ARTIST_ADMIN_AUDIT_EVENTS,
    ARTIST_ADMIN_ERROR_CODES,
    ARTIST_ADMIN_EVENTS,
    ARTIST_ADMIN_MONEY_CAPABILITY,
    ARTIST_ADMIN_READ_CAPABILITY,
    ARTIST_ADMIN_UPDATE_CAPABILITY,
    ARTIST_STATE_ACTIONS,
} from './admin/constants/artist-admin.constant';
export type { ArtistStateAction } from './admin/constants/artist-admin.constant';
export {
    artistStateActionSchema,
    artistStatsQuerySchema,
    artistSummaryQuerySchema,
    staffUpdateArtistSchema,
} from './admin/dto/artist-admin.dto';
export type {
    ArtistDirectorySummary,
    StaffArtistProfile,
    StaffArtistStats,
    StaffUpdateArtistDto,
} from './admin/dto/artist-admin.dto';
export { ARTIST_SORTS } from './profile/dto/artist.dto';
export type { ArtistSort } from './profile/dto/artist.dto';
export type { MoneyVisibilityResolver } from './admin/controller/artist-admin.controller';
// The port @hitbox/dashboard implements.
export type {
    ArtistAccountStatus,
    ArtistSalesRank,
    ArtistStats,
    IArtistInsights,
    InsightsWindow,
} from './admin/domain/artist-insights.port';
