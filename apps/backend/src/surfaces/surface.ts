import type { Router } from 'express';
import { env } from '@hitbox/shared';

/**
 * API SURFACES
 * ============
 * One backend (`api.hitbox.com`), one Clerk instance, one permission model —
 * but several client applications, each with a different blast radius:
 *
 *   PUBLIC  unauthenticated reads (storefront, NFC verification, webhooks)
 *   APP     hitbox.com  +  the mobile app        (customers and artists)
 *   ADMIN   admin.hitbox.com                     (platform operations)
 *   MANAGE  productmanager.hitbox.com            (tenant/business operations)
 *
 * A surface is NOT an authorization mechanism — permissions are, and they are
 * enforced identically no matter where a request comes from. A surface is
 * defence in depth plus operational hygiene:
 *
 *   - reachability: role administration simply is not routable from the mobile
 *     app, so a bug in a customer-facing route cannot reach it
 *   - CORS: each browser app gets its own origin allowlist
 *   - rate limits: an admin console and a public catalog deserve different ones
 *   - audit: every record carries the surface it came from, so "who refunded
 *     this, and from where?" is answerable
 *
 * Mobile clients send no Origin header (so CORS does not apply to them) and are
 * identified by the surface they call plus their Clerk session, exactly like the
 * web apps. There is no separate mobile authentication path.
 */
export const SURFACES = {
    PUBLIC: 'public',
    APP: 'app',
    ADMIN: 'admin',
    MANAGE: 'manage',
} as const;

export type SurfaceName = (typeof SURFACES)[keyof typeof SURFACES];

/** Where each surface is mounted under the versioned API prefix. */
export const SURFACE_MOUNTS: Record<SurfaceName, string> = {
    // PUBLIC and APP share the root so existing client paths keep working:
    //   /api/v1/products, /api/v1/collections/me, ...
    [SURFACES.PUBLIC]: '/',
    [SURFACES.APP]: '/',
    [SURFACES.ADMIN]: '/admin',
    [SURFACES.MANAGE]: '/manage',
};

/**
 * Browser origins allowed per surface. Unset (the default) means "any origin",
 * which is the behaviour this app already had — set these in production so
 * admin.hitbox.com is the only origin that can talk to the admin surface.
 */
export function allowedOriginsFor(surface: SurfaceName): string[] | null {
    const raw =
        surface === SURFACES.ADMIN
            ? env.CORS_ADMIN_ORIGINS
            : surface === SURFACES.MANAGE
                ? env.CORS_MANAGE_ORIGINS
                : env.CORS_APP_ORIGINS;

    if (!raw) return null;
    const origins = raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    return origins.length > 0 ? origins : null;
}

/** Rate-limit multiplier per surface, relative to RATE_LIMIT_MAX. */
export const SURFACE_RATE_MULTIPLIER: Record<SurfaceName, number> = {
    // Anonymous catalog browsing is the highest-volume, lowest-value traffic.
    [SURFACES.PUBLIC]: 1,
    [SURFACES.APP]: 1,
    // Small, known user populations doing expensive things — tighter limits
    // make credential-stuffing and scripted abuse of admin endpoints obvious.
    [SURFACES.ADMIN]: 0.5,
    [SURFACES.MANAGE]: 0.5,
};

export interface SurfaceDefinition {
    name: SurfaceName;
    router: Router;
}
