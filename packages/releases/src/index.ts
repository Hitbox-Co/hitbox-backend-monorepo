/**
 * @hitbox/releases
 *
 * Drop release approval workflow — review, decision and compliance sign-off.
 *
 * `ReleaseApproval` is append-only per version: resubmitting a rejected drop
 * creates version N+1 rather than overwriting the rejection, so the whole
 * review trail survives. Deciding mirrors the outcome onto
 * `Product.status` and `Product.complianceStatus` in one transaction — the
 * approval row is the evidence, the product columns are what the catalog and
 * storefront read, and a partial apply leaves a drop reviewers believe is
 * approved and buyers cannot see.
 */

export { createReleasesModule } from './module';
export type {
    ReleasesModule,
    ReleasesModuleDeps,
    ReleasesPermissionGuard,
} from './module';

export {
    RELEASE_DECIDE_CAPABILITY,
    RELEASE_EVENTS,
    RELEASE_OVERRIDE_CAPABILITY,
    RELEASE_READ_CAPABILITY,
    RELEASES_ERROR_CODES,
    RELEASES_MODULE,
} from './constants/releases.constant';

export {
    decideReleaseApprovalSchema,
    listReleaseApprovalsQuerySchema,
    submitForReviewSchema,
    updateReleaseApprovalSchema,
} from './dto/release.dto';
export type {
    DecideReleaseApprovalDto,
    ListReleaseApprovalsQuery,
    ReleaseApprovalDetail,
    ReleaseApprovalListItem,
    SubmitForReviewDto,
    UpdateReleaseApprovalDto,
} from './dto/release.dto';

export type { ReleaseCallerResolver } from './controller/release.controller';
export type { ReleaseService, ReleaseView } from './service/release.service';
