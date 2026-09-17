// Module factory
export { createArtistModule } from './module';
export type { ArtistModule, ArtistModuleDeps } from './module';

// Ports this module provides to others.
export { ArtistOwnershipAdapter } from './adapter/artist-ownership.adapter';

// Constants
export { ARTIST_MODULE } from './collection/constants/artist-collection.constant';
