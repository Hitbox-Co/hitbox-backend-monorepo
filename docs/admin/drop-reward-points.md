# Drop reward points

> Every drop carries **reward points**: what a buyer earns with it.
> **HitBox System Admin sets them, and nobody else can.** Everyone who can see
> a drop sees its points, the artist included, read-only.

---

## 1. Who can do what

| Who | See points | Set points |
|---|---|---|
| HitBox System Admin | ✅ | ✅ `PUT /admin/products/:id/reward-points` |
| HitBox Drop Manager | ✅ | ❌ `403`, even though they edit every drop |
| Artist | ✅ on their own drops | ❌ |
| Brand Admin / Employee | ✅ on their drops | ❌ |
| Buyers and the public | ✅ on live drops | ❌ |

**How it's enforced.** Setting points needs the permission
`drop:configure:global`, which only `HITBOX_SYSTEM_ADMIN` holds in the role
catalog. It is not covered by `drop:manage`, which covers create, read, update
and delete only. So everyone who can *edit* a drop (Drop Managers, Brand
Admins, artists) still can't change its points. It's a permission check, not
a role-name check: an operator who defines another platform-wide role and
grants it `drop:configure:global` gets the same right with no code change.

The drop form can't set points either. `POST` and `PATCH /admin/products`
don't accept `rewardPoints`, and since `PATCH` is strict, a body containing it
is refused with `422` naming the field.

---

## 2. `PUT /api/v1/admin/products/:id/reward-points` 🔒 System Admin

```json
{ "rewardPoints": 150, "reason": "Launch promo" }
```

| Field | Rules |
|---|---|
| `rewardPoints` | Whole number, `0`–`1000000` |
| `reason` | Optional, 1–500 characters. Kept in the audit trail. |

Response `200`: the drop (`{ "data": ProductResponse }`) with the new
`rewardPoints`. Sending the value the drop already has changes nothing and
writes no audit row.

| Status | Code | When |
|---|---|---|
| `403` | `AUTHZ_FORBIDDEN` | The caller doesn't hold `drop:configure` platform-wide |
| `404` | `PRODUCTS_NOT_FOUND` | No such drop |
| `422` | `VALIDATION_ERROR` | Negative, not a whole number, above the maximum, or an unknown field |

Each change is audited as **`product.reward-points.set`** (WARNING, persona
`hitbox_admin`), with `before` and `after` holding `{ rewardPoints }`,
`metadata.reason` when given, and actor type `HITBOX_ADMIN`. The drop is
announced as `products.product.updated` with
`{ productId, fields: ["rewardPoints"] }`, and its cached reads are refreshed.

---

## 3. Where points appear (read-only)

`rewardPoints` is a number, and `0` when none have been set. New and existing
drops start at `0`.

| Surface | Field |
|---|---|
| `GET /products`, `GET /products/:id`, `GET /products/code/:groupCode` | `rewardPoints` on every drop |
| `GET /admin/products/:id` (detail, artists and brands included) | `rewardPoints` |
| `GET /admin/dashboard/products` (admin drop list) | `items[].rewardPoints` |
| Discover cards (`/discover…`) | `rewardPoints` |
| Marketplace cards (`/marketplace…`) | `rewardPoints` |
| Buyer collection (`/collections/me…`) | `product.rewardPoints` |
| Artist collection: drops in it (`GET /artist/collections/:id`) | `drops[].rewardPoints` |
| Artist "Add drops" picker (`GET /artist/collections/:id/available-drops`) | `items[].rewardPoints` |

---

## 4. Setup

- Migration `20261029100000_drop_reward_points` adds
  `Drop.rewardPoints INTEGER NOT NULL DEFAULT 0` with a check that it's never
  negative.
- Run `pnpm db:seed:authz` once per environment. It adds the
  `drop:configure:global` permission and grants it to System Admin. Grants
  are cached for at most about a minute.
- Run `pnpm db:seed:audit` once per environment. It registers
  `product.reward-points.set`.

---

## 5. Console checklist

- [ ] Drop detail and lists: show **Reward points** read-only everywhere.
- [ ] System Admin only: an **Edit points** control (number input and an
      optional reason) → `PUT …/reward-points`, then replace the drop with
      `data`.
- [ ] Hide the control from everyone else. They'd get `403`.
- [ ] Don't send `rewardPoints` in the drop create or edit form; it's refused.
- [ ] Artist dashboard: show points on their drops, with no edit control.

---

## 6. Code map

```
packages/products/prisma/products.prisma                 Drop.rewardPoints
packages/products/src/constants/products.constant.ts     DROP_POINTS_CAPABILITY, REWARD_POINTS_MAX, audit event
packages/products/src/dto/product.dto.ts                 setRewardPointsSchema
packages/products/src/service/product.service.ts         setRewardPoints(), ProductResponse.rewardPoints
packages/products/src/module.ts                          PUT /admin/products/:id/reward-points
packages/access-control/src/domain/permission-catalog.ts drop:configure:global
packages/access-control/src/domain/role-catalog.ts       granted to HITBOX_SYSTEM_ADMIN only
packages/audit/src/domain/audit-event-catalog.ts         product.reward-points.set
packages/products/tests/reward-points.test.ts            who may set them, schemas, service
```
