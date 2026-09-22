/**
 * Artist profile sub-module.
 *
 * Today: the **directory** — the read-only list and lookup that fill the drop
 * form's artist picker and label catalog rows.
 *
 * Still to build: the public artist profile screen (bio, verified badge,
 * followers, the artist's collections grid) and the staff-facing profile
 * editor, which carry the fields this directory deliberately omits.
 */
export { ArtistRepository } from './repository/artist.repository';
export { ArtistService } from './service/artist.service';
export { ArtistController } from './controller/artist.controller';
