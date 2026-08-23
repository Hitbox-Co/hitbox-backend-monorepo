# 10 — Frontend integration

## The contract

One endpoint, called once at boot (and again after anything that could change
access):

```http
GET /api/v1/authz/me
Authorization: Bearer <clerk session token>
```

```json
{
  "data": {
    "userId": "usr_ayan",
    "platformRoles": ["USER", "ARTIST"],
    "organizations": [
      { "id": "org_acme", "slug": "acme", "name": "Acme Records", "roles": ["PRODUCT_MANAGER"] },
      { "id": "org_vinyl", "slug": "vinyl-co", "name": "Vinyl Co", "roles": ["ORDER_MANAGER"] }
    ],
    "activeOrganizationId": "org_acme",
    "permissions": [
      "analytics:read:own",
      "collection:create:own",
      "product:create:own",
      "product:read:any",
      "product:update:organization",
      "product:update:own",
      "order:read:organization"
    ],
    "capabilities": {
      "analytics:read": "own",
      "collection:create": "own",
      "product:create": "own",
      "product:read": "any",
      "product:update": "organization",
      "order:read": "organization"
    }
  }
}
```

`permissions` is the flat `resource:action:scope` list. `capabilities` maps each
`resource:action` to the **widest** scope held, which is what most UI questions
actually need: "can I edit anything, or only my own?" without the client parsing
scope strings.

This endpoint is available on every surface, needs no permission beyond being
signed in, and only ever describes the caller's own access.

## This is UX, not security

Say it out loud, because it is the most commonly misunderstood part of any
authorization system:

> The frontend decides what to **show**. The backend decides what to **allow**.

A tampered response buys the caller nothing but a misleading UI. Every request is
re-checked server-side against live database state. Hiding a Delete button is a
courtesy to the user, not a control.

Which also means: **do not** try to keep the two in sync by duplicating policy
logic in the client. The client asks "is this capability in my manifest?" — it
never re-implements scope rules.

## A minimal client helper

```ts
type Manifest = {
    userId: string;
    platformRoles: string[];
    organizations: { id: string; slug: string; name: string; roles: string[] }[];
    activeOrganizationId: string | null;
    permissions: string[];
    capabilities: Record<string, 'own' | 'organization' | 'any'>;
};

const RANK = { own: 1, organization: 2, any: 3 } as const;

export function createAccess(manifest: Manifest) {
    return {
        /** Do I hold this capability at all? Drives menus and buttons. */
        can(resource: string, action: string): boolean {
            return `${resource}:${action}` in manifest.capabilities;
        },

        /** Do I hold it at least this widely? Drives "all vs mine" toggles. */
        canAtLeast(resource: string, action: string, scope: keyof typeof RANK): boolean {
            const held = manifest.capabilities[`${resource}:${action}`];
            return held !== undefined && RANK[held] >= RANK[scope];
        },

        /**
         * Optimistic row-level hint, mirroring the backend rule. Use it to grey
         * out a control, never to decide whether to send the request.
         */
        canOnRow(
            resource: string,
            action: string,
            row: { ownerId?: string | null; organizationId?: string | null },
        ): boolean {
            const held = manifest.capabilities[`${resource}:${action}`];
            if (!held) return false;
            if (held === 'any') return true;
            if (held === 'organization') {
                return !!row.organizationId && row.organizationId === manifest.activeOrganizationId;
            }
            return !!row.ownerId && row.ownerId === manifest.userId;
        },
    };
}
```

### React

```tsx
const AccessContext = createContext<ReturnType<typeof createAccess> | null>(null);

export function AccessProvider({ children }: { children: React.ReactNode }) {
    const { getToken } = useAuth();                 // @clerk/clerk-react
    const [access, setAccess] = useState<ReturnType<typeof createAccess> | null>(null);

    useEffect(() => {
        (async () => {
            const res = await fetch(`${API}/api/v1/authz/me`, {
                headers: { Authorization: `Bearer ${await getToken()}` },
            });
            const { data } = await res.json();
            setAccess(createAccess(data));
        })();
    }, [getToken]);

    if (!access) return <FullPageSpinner />;
    return <AccessContext.Provider value={access}>{children}</AccessContext.Provider>;
}

export const useAccess = () => {
    const value = useContext(AccessContext);
    if (!value) throw new Error('useAccess must be used inside AccessProvider');
    return value;
};
```

```tsx
function ProductActions({ product }: { product: Product }) {
    const access = useAccess();
    return (
        <>
            {access.canOnRow('product', 'update', product) && <EditButton />}
            {access.canOnRow('product', 'delete', product) && <DeleteButton />}
            {access.can('product', 'publish') && <PublishButton />}
        </>
    );
}

function Nav() {
    const access = useAccess();
    return (
        <nav>
            <Link to="/collection">My Collection</Link>
            {access.can('product', 'create') && <Link to="/studio">Artist Studio</Link>}
            {access.can('order', 'read') && <Link to="/orders">Orders</Link>}
            {access.can('role', 'assign') && <Link to="/team">Team</Link>}
            {access.can('financial-report', 'read') && <Link to="/finance">Finance</Link>}
        </nav>
    );
}
```

### Route guards

```tsx
function RequireCapability({ resource, action, children }) {
    const access = useAccess();
    if (!access.can(resource, action)) return <Navigate to="/403" replace />;
    return children;
}

<Route path="/finance" element={
    <RequireCapability resource="financial-report" action="read">
        <FinanceDashboard />
    </RequireCapability>
} />
```

A route guard is still only UX. The data the page loads is protected by the API.

## Per-application usage

All three web apps and the mobile app use the same Clerk instance, the same
`/authz/me`, and the same helper. They differ only in which surface they call and
what they render.

### `hitbox.com` — customers and artists

```ts
const API = 'https://api.hitbox.com/api/v1';
```

An artist is not a different app or a different login: they are a user who also
holds `ARTIST`, so `product:create:own` appears in their manifest and the Studio
navigation item renders. The same build serves both.

### `admin.hitbox.com`

```ts
const API = 'https://api.hitbox.com/api/v1/admin';
```

Gate the whole app on a platform capability, then individual sections:

```tsx
if (!access.canAtLeast('user', 'read', 'any')) return <NotAuthorized />;
```

Role administration lives here and is **not routable** from the other surfaces —
defence in depth on top of the permission checks.

### `productmanager.hitbox.com`

```ts
const API = 'https://api.hitbox.com/api/v1/manage';
```

This surface is tenant-oriented, so send the organization on every request:

```ts
const headers = {
    Authorization: `Bearer ${token}`,
    'X-Organization-Id': activeOrganizationId,
};
```

Users in several organizations need a switcher. Build it from
`manifest.organizations`, and **re-fetch the manifest after switching** so
`activeOrganizationId` and the org-scoped capabilities are correct:

```tsx
function OrgSwitcher() {
    const { organizations, activeOrganizationId } = useManifest();
    return (
        <select value={activeOrganizationId ?? ''} onChange={(e) => setActiveOrg(e.target.value)}>
            {organizations.map((org) => (
                <option key={org.id} value={org.id}>{org.name}</option>
            ))}
        </select>
    );
}
```

If a user belongs to exactly one organization the header is optional — the backend
defaults to it. With several, omitting it yields
`400 AUTHZ_ORGANIZATION_REQUIRED`, because guessing which tenant a write lands in
is not acceptable.

### Mobile

Identical to `hitbox.com`. A phone and a browser are the same principal with the
same permissions; only presentation differs. Send the Clerk token as a Bearer
header (there is no cookie), and note that CORS does not apply — mobile clients
send no `Origin`.

## Handling the error codes

| Code | Status | What the client should do |
|---|---|---|
| `AUTH_UNAUTHENTICATED` / `AUTH_INVALID_TOKEN` | 401 | refresh the Clerk token, then retry once; on repeat, sign in |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | show a terminal "account suspended" screen |
| `AUTH_EMAIL_UNVERIFIED` | 403 | send them through Clerk's verification flow |
| `AUTHZ_PERMISSION_DENIED` | 403 | the UI was out of date — **re-fetch the manifest**, then show "not authorized" |
| `AUTHZ_RESOURCE_FORBIDDEN` | 403 | "you cannot do that to this item" |
| `AUTHZ_ORGANIZATION_REQUIRED` | 400 | prompt the organization switcher |
| `AUTHZ_ORGANIZATION_FORBIDDEN` | 403 | drop the stale org from local state, re-fetch |
| `AUTHZ_STEP_UP_REQUIRED` | 403 | run Clerk re-verification, then retry the request |
| `RATE_LIMITED` | 429 | back off using the `RateLimit-Reset` header |

### Step-up

```ts
async function callWithStepUp(request: () => Promise<Response>) {
    let res = await request();
    if (res.status === 403) {
        const body = await res.clone().json().catch(() => null);
        if (body?.error?.code === 'AUTHZ_STEP_UP_REQUIRED') {
            await clerk.session?.reverify();   // or Clerk's <__experimental_Reverification/>
            res = await request();
        }
    }
    return res;
}
```

Expect this on refunds, deletions, suspensions, role changes and audit exports.

## When to re-fetch the manifest

- at boot, after sign-in
- after switching organization
- on any `AUTHZ_PERMISSION_DENIED` (the UI is stale by definition)
- after an admin action that changed the current user's own access
- optionally, on a long poll or window refocus — the backend cache TTL is 300s,
  so anything longer is pointless

Do not poll aggressively. The manifest is a rendering hint; the backend is
authoritative, so being a few seconds behind is only ever a cosmetic problem.

## Related

- [05 — Clerk integration](05-clerk-integration.md)
- [11 — API surfaces](11-api-surfaces.md)
- [06 — Backend authorization](06-backend-authorization.md)
