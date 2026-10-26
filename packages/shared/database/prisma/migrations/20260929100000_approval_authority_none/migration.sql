-- ============================================================================
-- ApprovalAuthority gains NONE — "there is nobody to ask".
--
-- A drop that names neither an artist nor an organization is HitBox's own, and
-- the review exists to capture an owner's consent. With no owner outside
-- HitBox there is no consent to capture, so these reviews are opened and
-- decided in the same transaction rather than waiting in a queue nobody is
-- expected to action.
--
-- Appended, not inserted: an enum value's position is part of the physical type
-- in Postgres, and inserting would rewrite every existing row's representation.
-- Appending is metadata-only and takes no table lock on the rows.
--
-- No backfill. Existing PLATFORM rows stay PLATFORM: they were decided by a
-- person under the old rule, and rewriting them would claim an automatic
-- decision was made where a human actually made one.
-- ============================================================================

ALTER TYPE "ApprovalAuthority" ADD VALUE IF NOT EXISTS 'NONE';
