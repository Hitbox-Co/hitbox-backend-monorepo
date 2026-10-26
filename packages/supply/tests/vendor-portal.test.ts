import pino from 'pino';
import { VendorMemberStatus } from '@hitbox/database';
import { buildSupplyAccess } from '../src/domain/supply-access';
import { NOOP_SUPPLY_AUDIT } from '../src/domain/interfaces/supply-audit.interface';
import type { IVendorInvitations } from '../src/domain/interfaces/vendor-invitations.interface';
import { VendorAdminService } from '../src/service/vendor-admin.service';
import { VendorPortalService } from '../src/service/vendor-portal.service';
import type { SupplyMutationContext, SupplyService } from '../src/service/supply.service';
import type { SupplyRepository } from '../src/repository/supply.repository';
import type { VendorPortalRepository } from '../src/repository/vendor-portal.repository';
import { assertManifestVariants } from '../src/service/supply.service';
import { AllotmentGate } from '../src/service/allotment';

/**
 * The vendor portal's two rules, end to end through the services with
 * in-memory stand-ins for the repositories:
 *
 *   1. An invitation becomes portal access only through a VendorMember row,
 *      and one account acts for one vendor.
 *   2. A vendor books supply only against drops assigned to it — checked again
 *      at manifest time, so withdrawing a drop takes effect immediately.
 */

const logger = pino({ level: 'silent' });
const eventBus = { publish: jest.fn(async () => { }), subscribe: jest.fn() };

const ADMIN = 'admin-1';
const VENDOR_A = 'vendor-a';
const VENDOR_B = 'vendor-b';
/** A red T-shirt drop: three size variants. */
const DROP_1 = 'drop-1';
/** A drop with no variants. */
const DROP_2 = 'drop-2';
const RED_S = 'v-red-s';
const RED_M = 'v-red-m';
const RED_L = 'v-red-l';
const VARIANTS: Record<string, string[]> = { [DROP_1]: [RED_S, RED_M, RED_L], [DROP_2]: [] };
const variantMeta = (id: string) => ({
    variantCode: id.toUpperCase(),
    label: id,
    optionsKey: `color=RED|size=${id.slice(-1).toUpperCase()}`,
    position: VARIANTS[DROP_1]!.indexOf(id),
});
/** The allotment from the brief: 300 shirts, 100 per size. */
const RED_ALLOTMENT = [
    { variantId: RED_S, quantity: 100 },
    { variantId: RED_M, quantity: 100 },
    { variantId: RED_L, quantity: 100 },
];

const adminContext: SupplyMutationContext = {
    access: buildSupplyAccess({
        userId: ADMIN,
        permissions: ['nfc-tag-claim:manage:global', 'drop:manage:global'],
        roles: [],
    }),
    correlationId: 'corr-1',
};

function vendorRow(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        name: id,
        legalName: null,
        country: 'IN',
        vendorType: 'FIGURE',
        contactName: null,
        contactEmail: `contact@${id}.test`,
        contactPhone: null,
        notes: null,
        isActive: true,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { supplyBatchs: 0, skus: 0 },
        ...overrides,
    };
}

function build(options: { existingUserId?: string | null } = {}) {
    const vendors = new Map([
        [VENDOR_A, vendorRow(VENDOR_A)],
        [VENDOR_B, vendorRow(VENDOR_B)],
    ]);
    const members: any[] = [];
    const assignments: any[] = [];
    const batches: any[] = [];

    const supply = {
        findVendorById: async (id: string) => vendors.get(id) ?? null,
        findDropOrganization: async (id: string) =>
            [DROP_1, DROP_2].includes(id) ? 'org-1' : undefined,
        findDropVariants: async (dropId: string) =>
            (VARIANTS[dropId] ?? []).map((id) => ({
                id,
                ...variantMeta(id),
                isActive: true,
                archivedAt: null,
            })),
    } as unknown as SupplyRepository;

    const counted = (vendorId: string, dropId: string, filter: any = {}) =>
        batches.filter(
            (b) =>
                b.vendorId === vendorId &&
                b.dropId === dropId &&
                (filter.acceptedOnly ? b.status === 'ACCEPTED' : b.status !== 'REJECTED') &&
                b.id !== filter.excludeBatchId,
        );

    const portal = {
        findLiveByEmail: async (email: string) =>
            members.find((m) => m.email === email && m.status !== VendorMemberStatus.REVOKED) ??
            null,
        findByUserId: async (userId: string) => members.find((m) => m.userId === userId) ?? null,
        findByInvitationId: async (id: string) =>
            members.find((m) => m.invitationId === id) ?? null,
        findMember: async (vendorId: string, id: string) =>
            members.find((m) => m.id === id && m.vendorId === vendorId) ?? null,
        listMembers: async (vendorId: string) => members.filter((m) => m.vendorId === vendorId),
        createMember: async (data: any) => {
            const row = {
                id: `m-${members.length + 1}`,
                ...data,
                status: data.userId ? VendorMemberStatus.ACTIVE : VendorMemberStatus.INVITED,
                invitedAt: new Date(),
                acceptedAt: data.userId ? new Date() : null,
                revokedAt: null,
                revokeReason: null,
            };
            members.push(row);
            return row;
        },
        activate: async (id: string, userId: string) => {
            const row = members.find((m) => m.id === id);
            Object.assign(row, { userId, status: VendorMemberStatus.ACTIVE, acceptedAt: new Date() });
            return row;
        },
        revoke: async ({ id, reason }: { id: string; reason: string }) => {
            const row = members.find((m) => m.id === id);
            Object.assign(row, {
                status: VendorMemberStatus.REVOKED,
                revokedAt: new Date(),
                revokeReason: reason,
                userId: null,
            });
            return row;
        },
        findAssignment: async (vendorId: string, dropId: string) =>
            assignments.find((a) => a.vendorId === vendorId && a.dropId === dropId) ?? null,
        createAssignment: async ({ variants, ...data }: any) => {
            const row = {
                id: `a-${assignments.length + 1}`,
                ...data,
                assignedAt: new Date(),
                drop: { id: data.dropId, groupCode: 'G', name: 'Drop', status: 'DRAFT' },
                allotments: variants.map((v: any) => ({ ...v, variant: variantMeta(v.variantId) })),
            };
            assignments.push(row);
            return row;
        },
        replaceAllotment: async (input: any) => {
            const row = assignments.find((a) => a.id === input.assignmentId);
            row.quantity = input.quantity;
            row.allotments = input.variants.map((v: any) => ({
                ...v,
                variant: variantMeta(v.variantId),
            }));
            return row;
        },
        totalsForDrop: async (vendorId: string, dropId: string, filter?: any) => ({
            booked: counted(vendorId, dropId, filter).reduce((sum, b) => sum + b.quantity, 0),
            registered: 0,
            accepted: 0,
        }),
        totalsByVariant: async (vendorId: string, dropId: string, filter?: any) => {
            const totals = new Map<string, any>();
            for (const batch of counted(vendorId, dropId, filter)) {
                for (const line of batch.lines) {
                    const t = totals.get(line.variantId) ?? { booked: 0, registered: 0, accepted: 0 };
                    t.booked += line.quantity;
                    totals.set(line.variantId, t);
                }
            }
            return totals;
        },
        deleteAssignment: async (id: string) => {
            assignments.splice(assignments.findIndex((a) => a.id === id), 1);
        },
        listAssignments: async (vendorId: string) =>
            assignments.filter((a) => a.vendorId === vendorId),
        findVendorBatch: async (vendorId: string, id: string) =>
            batches.find((b) => b.id === id && b.vendorId === vendorId) ?? null,
    } as unknown as VendorPortalRepository;

    const invitations: jest.Mocked<IVendorInvitations> = {
        invite: jest.fn(async () => ({
            invitationId: `inv-${members.length + 1}`,
            userId: options.existingUserId ?? null,
            outcome: options.existingUserId ? ('ROLE_ASSIGNED' as const) : ('INVITATION_SENT' as const),
            expiresAt: new Date(Date.now() + 3_600_000),
        })),
        revoke: jest.fn(async () => { }),
    };

    const supplyService = {
        bookConsignment: jest.fn(async (input: any) => {
            const row = batchRow(
                `b-${batches.length + 1}`,
                input.dto.vendorId,
                input.dto.dropId,
                input.dto.lines,
                input.dto.quantity,
            );
            batches.push(row);
            return row;
        }),
        assertLinesBelongToDrop: jest.fn(async () => { }),
        applyManifest: jest.fn(async (input: any) => ({
            batchId: input.batch.id,
            dryRun: false,
            registered: input.dto.tags.length,
            duplicates: [],
            batch: { rowsReceived: 1, rowsAccepted: 1, rowsRejected: 0, status: 'UPLOADED' },
        })),
    } as unknown as jest.Mocked<SupplyService>;

    const admin = new VendorAdminService({
        supply,
        portal,
        invitations,
        eventBus,
        audit: NOOP_SUPPLY_AUDIT,
        logger,
    });
    const gate = new AllotmentGate(portal);
    const vendorPortal = new VendorPortalService({ supply, portal, supplyService, allotmentGate: gate });
    return { admin, vendorPortal, gate, invitations, supplyService, members, batches, vendors };
}

function batchRow(
    id: string,
    vendorId: string,
    dropId: string | null,
    lines: { variantId: string; quantity: number }[] = [],
    quantity?: number,
) {
    const now = new Date();
    return {
        id,
        vendorId,
        vendor: { id: vendorId, name: vendorId, vendorType: 'FIGURE' },
        dropId,
        drop: dropId ? { id: dropId, groupCode: 'G', name: 'Drop' } : null,
        itemType: 'FIGURE',
        status: 'UPLOADED',
        quantity: lines.length ? lines.reduce((sum, l) => sum + l.quantity, 0) : (quantity ?? 10),
        lines: lines.map((l) => ({
            ...l,
            variant: variantMeta(l.variantId),
            rowsReceived: 0,
            rowsAccepted: 0,
            rowsRejected: 0,
        })),
        batchRef: null,
        vendorInvoiceRef: null,
        receivedAt: now,
        batchDate: now,
        rowsReceived: 0,
        rowsAccepted: 0,
        rowsRejected: 0,
        sourceFileRef: null,
        validationReportRef: null,
        enteredById: 'u',
        notes: null,
        createdAt: now,
        updatedAt: now,
        _count: { nfcTags: 0 },
    };
}

const createDto = (dropId: string, lines?: { variantId: string; quantity: number }[]) => ({
    dropId,
    itemType: 'APPAREL' as const,
    ...(lines ? { lines } : { quantity: 10 }),
    receivedAt: new Date(),
});

describe('vendor invitations', () => {
    it('invites the contact email by default and leaves the member INVITED until accepted', async () => {
        const { admin, invitations } = build();
        const result = await admin.inviteMember(adminContext, [], VENDOR_A, {});

        expect(invitations.invite).toHaveBeenCalledWith(
            expect.objectContaining({ email: `contact@${VENDOR_A}.test`, invitedById: ADMIN }),
        );
        expect(result.outcome).toBe('INVITATION_SENT');
        expect(result.member.status).toBe(VendorMemberStatus.INVITED);
        expect(result.member.userId).toBeNull();
    });

    it('activates the member when the invitation is accepted, and only once', async () => {
        const { admin, members } = build();
        const { member } = await admin.inviteMember(adminContext, [], VENDOR_A, {
            email: 'Ops@Vendor.test',
        });
        expect(member.email).toBe('ops@vendor.test');

        const event = { invitationId: member.invitationId!, email: member.email, userId: 'user-9' };
        await admin.onInvitationAccepted(event);
        await admin.onInvitationAccepted(event); // replayed

        expect(members[0].status).toBe(VendorMemberStatus.ACTIVE);
        expect(members[0].userId).toBe('user-9');
    });

    it('ignores accepted invitations that are not a vendor\'s', async () => {
        const { admin, members } = build();
        await admin.onInvitationAccepted({ invitationId: 'someone-else', email: 'x@y.z', userId: 'u' });
        expect(members).toHaveLength(0);
    });

    it('writes the member ACTIVE straight away when the address already has an account', async () => {
        const { admin } = build({ existingUserId: 'user-1' });
        const result = await admin.inviteMember(adminContext, [], VENDOR_A, { email: 'a@b.test' });
        expect(result.outcome).toBe('ROLE_ASSIGNED');
        expect(result.member.status).toBe(VendorMemberStatus.ACTIVE);
        expect(result.member.userId).toBe('user-1');
    });

    it('refuses an address that already acts for another vendor, before sending anything', async () => {
        const { admin, invitations } = build();
        await admin.inviteMember(adminContext, [], VENDOR_A, { email: 'a@b.test' });
        invitations.invite.mockClear();

        await expect(
            admin.inviteMember(adminContext, [], VENDOR_B, { email: 'a@b.test' }),
        ).rejects.toMatchObject({ code: 'SUPPLY_VENDOR_MEMBER_OTHER_VENDOR' });
        expect(invitations.invite).not.toHaveBeenCalled();
    });

    it('refuses to invite for an inactive vendor', async () => {
        const { admin, vendors } = build();
        vendors.set(VENDOR_A, vendorRow(VENDOR_A, { isActive: false }));
        await expect(admin.inviteMember(adminContext, [], VENDOR_A, {})).rejects.toMatchObject({
            code: 'SUPPLY_VENDOR_INACTIVE',
        });
    });

    it('withdraws the staff invitation when an INVITED member is revoked', async () => {
        const { admin, invitations } = build();
        const { member } = await admin.inviteMember(adminContext, [], VENDOR_A, {});
        const revoked = await admin.revokeMember(adminContext, VENDOR_A, member.id, {
            reason: 'wrong person',
        });
        expect(revoked.status).toBe(VendorMemberStatus.REVOKED);
        expect(invitations.revoke).toHaveBeenCalledWith(
            expect.objectContaining({ invitationId: member.invitationId }),
        );
    });

    it('requires the supply write capability', async () => {
        const { admin } = build();
        const reader: SupplyMutationContext = {
            access: buildSupplyAccess({ userId: 'u', permissions: ['drop:read:global'], roles: [] }),
            correlationId: 'c',
        };
        await expect(admin.inviteMember(reader, [], VENDOR_A, {})).rejects.toMatchObject({
            statusCode: 403,
        });
    });
});

describe('vendor portal', () => {
    async function activeVendor(userId = 'user-1') {
        const env = build({ existingUserId: userId });
        await env.admin.inviteMember(adminContext, [], VENDOR_A, { email: 'v@a.test' });
        await env.admin.assignDrop(adminContext, VENDOR_A, {
            dropId: DROP_1,
            variants: RED_ALLOTMENT,
        });
        return env;
    }

    it('lets an account with no membership do nothing', async () => {
        const { vendorPortal } = build();
        await expect(vendorPortal.me('stranger')).rejects.toMatchObject({
            code: 'SUPPLY_VENDOR_MEMBERSHIP_REQUIRED',
        });
    });

    it('lists only the drops assigned to the caller\'s vendor', async () => {
        const { vendorPortal } = await activeVendor();
        const drops = await vendorPortal.listDrops('user-1');
        expect(drops.data.map((d) => d.dropId)).toEqual([DROP_1]);
    });

    it('books a consignment for an assigned drop, always under the caller\'s vendor', async () => {
        const { vendorPortal, supplyService } = await activeVendor();
        const batch = await vendorPortal.createBatch(
            'user-1',
            'c',
            createDto(DROP_1, [{ variantId: RED_S, quantity: 100 }]),
        );

        expect(batch.vendorId).toBe(VENDOR_A);
        expect(supplyService.bookConsignment).toHaveBeenCalledWith(
            expect.objectContaining({ actorType: 'VENDOR', actorId: 'user-1' }),
        );
    });

    it('refuses a consignment for a drop that is not assigned', async () => {
        const { vendorPortal, supplyService } = await activeVendor();
        await expect(
            vendorPortal.createBatch('user-1', 'c', createDto(DROP_2)),
        ).rejects.toMatchObject({ code: 'SUPPLY_DROP_NOT_ASSIGNED' });
        expect(supplyService.bookConsignment).not.toHaveBeenCalled();
    });

    it('stops manifests the moment a drop is unassigned', async () => {
        const { vendorPortal, admin, batches } = await activeVendor();
        const batch = await vendorPortal.createBatch(
            'user-1',
            'c',
            createDto(DROP_1, [{ variantId: RED_M, quantity: 10 }]),
        );
        const manifest = { tags: [{ uid: '04A1B2C3D4E5F6', variantId: RED_M }], dryRun: false } as any;
        batches[0].status = 'VALIDATED';

        await expect(
            vendorPortal.registerTags('user-1', 'c', batch.id, manifest),
        ).resolves.toMatchObject({ registered: 1 });

        await admin.unassignDrop(adminContext, VENDOR_A, DROP_1);
        await expect(
            vendorPortal.registerTags('user-1', 'c', batch.id, manifest),
        ).rejects.toMatchObject({ code: 'SUPPLY_DROP_NOT_ASSIGNED' });
    });

    it('hides another vendor\'s consignment behind a 404', async () => {
        const { vendorPortal, batches } = await activeVendor();
        batches.push(batchRow('b-other', VENDOR_B, DROP_1));
        await expect(vendorPortal.getBatch('user-1', 'b-other')).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    it('closes the portal as soon as the member is revoked', async () => {
        const { vendorPortal, admin, members } = await activeVendor();
        await admin.revokeMember(adminContext, VENDOR_A, members[0].id, { reason: 'left' });
        await expect(vendorPortal.listDrops('user-1')).rejects.toMatchObject({
            code: 'SUPPLY_VENDOR_MEMBERSHIP_REQUIRED',
        });
    });

    it('keeps reads but refuses new supply once the vendor is deactivated', async () => {
        const { vendorPortal, vendors } = await activeVendor();
        vendors.set(VENDOR_A, vendorRow(VENDOR_A, { isActive: false }));
        await expect(vendorPortal.me('user-1')).resolves.toBeDefined();
        await expect(
            vendorPortal.createBatch('user-1', 'c', createDto(DROP_1, RED_ALLOTMENT)),
        ).rejects.toMatchObject({ code: 'SUPPLY_VENDOR_INACTIVE' });
    });
});

describe('variant-wise allotment — 300 red shirts as 100 S / 100 M / 100 L', () => {
    async function assigned() {
        const env = build({ existingUserId: 'user-1' });
        await env.admin.inviteMember(adminContext, [], VENDOR_A, { email: 'v@a.test' });
        await env.admin.assignDrop(adminContext, VENDOR_A, { dropId: DROP_1, variants: RED_ALLOTMENT });
        return env;
    }

    it('requires a per-variant allotment for a drop with variants', async () => {
        const { admin } = build();
        await expect(
            admin.assignDrop(adminContext, VENDOR_A, { dropId: DROP_1, quantity: 300 }),
        ).rejects.toMatchObject({ code: 'SUPPLY_ALLOTMENT_SHAPE_INVALID' });
    });

    it('refuses a variant that does not belong to the drop', async () => {
        const { admin } = build();
        await expect(
            admin.assignDrop(adminContext, VENDOR_A, {
                dropId: DROP_1,
                variants: [{ variantId: 'v-blue-s', quantity: 10 }],
            }),
        ).rejects.toMatchObject({ code: 'SUPPLY_VARIANT_INVALID' });
    });

    it('takes a plain quantity for a drop without variants', async () => {
        const { admin } = build();
        const row = await admin.assignDrop(adminContext, VENDOR_A, { dropId: DROP_2, quantity: 50 });
        expect(row.byVariant).toBe(false);
        expect(row.progress).toMatchObject({ allotted: 50, booked: 0, remaining: 50 });
    });

    it('reports allotted / booked / remaining per variant', async () => {
        const { vendorPortal } = await assigned();
        await vendorPortal.createBatch('user-1', 'c', createDto(DROP_1, [
            { variantId: RED_S, quantity: 60 },
            { variantId: RED_M, quantity: 100 },
        ]));

        const [drop] = (await vendorPortal.listDrops('user-1')).data;
        expect(drop!.byVariant).toBe(true);
        expect(drop!.progress).toMatchObject({ allotted: 300, booked: 160, remaining: 140 });
        const bySize = Object.fromEntries(drop!.variants.map((v) => [v.variantId, v.remaining]));
        expect(bySize).toEqual({ [RED_S]: 40, [RED_M]: 0, [RED_L]: 100 });
    });

    it('lets a vendor book beyond its allotment, and says so', async () => {
        const { vendorPortal } = await assigned();
        await vendorPortal.createBatch('user-1', 'c', createDto(DROP_1, [{ variantId: RED_S, quantity: 80 }]));

        const over = await vendorPortal.createBatch(
            'user-1',
            'c',
            createDto(DROP_1, [{ variantId: RED_S, quantity: 30 }]),
        );
        expect(over.allotment?.covered).toBe(true); // nothing accepted yet — this alone fits

        const [drop] = (await vendorPortal.listDrops('user-1')).data;
        const small = drop!.variants.find((v) => v.variantId === RED_S)!;
        expect(small).toMatchObject({ allotted: 100, booked: 110, remaining: 0, overBooked: 10 });
    });

    it('lists a booked variant that has no allotment at allotted 0', async () => {
        const env = build({ existingUserId: 'user-1' });
        await env.admin.inviteMember(adminContext, [], VENDOR_A, { email: 'v@a.test' });
        await env.admin.assignDrop(adminContext, VENDOR_A, {
            dropId: DROP_1,
            variants: [{ variantId: RED_S, quantity: 100 }],
        });
        await env.vendorPortal.createBatch('user-1', 'c', createDto(DROP_1, [{ variantId: RED_L, quantity: 5 }]));

        const [drop] = (await env.vendorPortal.listDrops('user-1')).data;
        expect(drop!.variants.find((v) => v.variantId === RED_L)).toMatchObject({
            allotted: 0,
            booked: 5,
            overBooked: 5,
        });
    });

    it('frees allotment held by a rejected consignment', async () => {
        const { vendorPortal, batches } = await assigned();
        await vendorPortal.createBatch('user-1', 'c', createDto(DROP_1, [{ variantId: RED_L, quantity: 100 }]));
        batches[0].status = 'REJECTED';
        await expect(
            vendorPortal.createBatch('user-1', 'c', createDto(DROP_1, [{ variantId: RED_L, quantity: 100 }])),
        ).resolves.toBeDefined();
    });

    it('needs lines, not a plain quantity, when the allotment is by variant', async () => {
        const { vendorPortal } = await assigned();
        await expect(
            vendorPortal.createBatch('user-1', 'c', createDto(DROP_1)),
        ).rejects.toMatchObject({ code: 'SUPPLY_ALLOTMENT_SHAPE_INVALID' });
    });

    it('will not cut an allotment below what is already accepted', async () => {
        const { vendorPortal, admin, batches } = await assigned();
        await vendorPortal.createBatch('user-1', 'c', createDto(DROP_1, [{ variantId: RED_S, quantity: 70 }]));
        batches[0].status = 'ACCEPTED';

        await expect(
            admin.updateAllotment(adminContext, VENDOR_A, DROP_1, {
                variants: [{ variantId: RED_S, quantity: 50 }, { variantId: RED_M, quantity: 100 }],
            }),
        ).rejects.toMatchObject({ code: 'SUPPLY_ALLOTMENT_BELOW_ACCEPTED' });

        const updated = await admin.updateAllotment(adminContext, VENDOR_A, DROP_1, {
            variants: [{ variantId: RED_S, quantity: 120 }, { variantId: RED_M, quantity: 100 }],
        });
        expect(updated.variants.map((v) => v.variantId)).toEqual([RED_S, RED_M]);
        expect(updated.progress.allotted).toBe(220);
    });
});

describe('manifest rows carry their variant', () => {
    const line = (variantId: string, quantity: number, rowsReceived = 0) => ({
        variantId,
        quantity,
        rowsReceived,
        rowsAccepted: rowsReceived,
        rowsRejected: 0,
        variant: { variantCode: variantId.toUpperCase(), label: variantId, position: 0 },
    });
    const batch = { lines: [line(RED_S, 2), line(RED_M, 2, 1)] } as any;
    const rows = (...variantIds: (string | undefined)[]) =>
        ({ tags: variantIds.map((variantId, i) => ({ uid: `04A1B2C3D4E5F${i}`, variantId })), dryRun: false }) as any;

    it('counts chips per variant', () => {
        const counts = assertManifestVariants(batch, rows(RED_S, RED_S, RED_M));
        expect(counts.get(RED_S)).toEqual({ received: 2, accepted: 2 });
        expect(counts.get(RED_M)).toEqual({ received: 1, accepted: 1 });
    });

    it('needs a variant on every row of a split consignment', () => {
        expect(() => assertManifestVariants(batch, rows(RED_S, undefined))).toThrow(
            expect.objectContaining({ code: 'SUPPLY_VARIANT_REQUIRED', details: { rows: [2] } }),
        );
    });

    it('refuses a variant the consignment has no line for', () => {
        expect(() => assertManifestVariants(batch, rows(RED_L))).toThrow(
            expect.objectContaining({ code: 'SUPPLY_VARIANT_NOT_IN_BATCH' }),
        );
    });

    it('refuses more chips on a variant than its line declares', () => {
        expect(() => assertManifestVariants(batch, rows(RED_M, RED_M))).toThrow(
            expect.objectContaining({ code: 'SUPPLY_LINE_QUANTITY_EXCEEDED' }),
        );
    });

    it('refuses variants on a consignment without lines', () => {
        expect(() => assertManifestVariants({ lines: [] } as any, rows(RED_S))).toThrow(
            expect.objectContaining({ code: 'SUPPLY_VARIANT_NOT_IN_BATCH' }),
        );
    });
});

describe('accepting needs the allotment to cover the consignment', () => {
    async function overBooked() {
        const env = build({ existingUserId: 'user-1' });
        await env.admin.inviteMember(adminContext, [], VENDOR_A, { email: 'v@a.test' });
        await env.admin.assignDrop(adminContext, VENDOR_A, { dropId: DROP_1, variants: RED_ALLOTMENT });
        // First carton: 100 S, accepted. Second: 20 more S and 50 M — S is now over.
        await env.vendorPortal.createBatch('user-1', 'c', createDto(DROP_1, [{ variantId: RED_S, quantity: 100 }]));
        env.batches[0].status = 'ACCEPTED';
        await env.vendorPortal.createBatch('user-1', 'c', createDto(DROP_1, [
            { variantId: RED_S, quantity: 20 },
            { variantId: RED_M, quantity: 50 },
        ]));
        return { ...env, second: env.batches[1] };
    }

    it('reports which variant is short, by how much, and the PATCH that fixes it', async () => {
        const { gate, second } = await overBooked();
        const check = await gate.check(second);

        expect(check).toMatchObject({ covered: false, byVariant: true });
        expect(check!.variants).toEqual([
            expect.objectContaining({ variantId: RED_S, allotted: 100, acceptedElsewhere: 100, thisBatch: 20, shortBy: 20 }),
            expect.objectContaining({ variantId: RED_M, allotted: 100, acceptedElsewhere: 0, thisBatch: 50, shortBy: 0 }),
        ]);
        expect(check!.suggestedPatch).toEqual({ variants: [{ variantId: RED_S, quantity: 120 }] });
    });

    it('is covered once the admin raises that variant — and only that variant changes', async () => {
        const { gate, admin, second } = await overBooked();
        const updated = await admin.patchAllotment(adminContext, VENDOR_A, DROP_1, {
            variants: [{ variantId: RED_S, quantity: 120 }],
        });

        expect(Object.fromEntries(updated.variants.map((v) => [v.variantId, v.allotted]))).toEqual({
            [RED_S]: 120,
            [RED_M]: 100,
            [RED_L]: 100,
        });
        expect((await gate.check(second))!.covered).toBe(true);
    });

    it('checks a drop without variants at drop level', async () => {
        const env = build({ existingUserId: 'user-1' });
        await env.admin.inviteMember(adminContext, [], VENDOR_A, { email: 'v@a.test' });
        await env.admin.assignDrop(adminContext, VENDOR_A, { dropId: DROP_2, quantity: 15 });
        await env.vendorPortal.createBatch('user-1', 'c', createDto(DROP_2)); // 10
        env.batches[0].status = 'ACCEPTED';
        await env.vendorPortal.createBatch('user-1', 'c', createDto(DROP_2)); // 10 more

        const check = await env.gate.check(env.batches[1]);
        expect(check).toMatchObject({
            covered: false,
            total: { allotted: 15, acceptedElsewhere: 10, thisBatch: 10, shortBy: 5 },
            suggestedPatch: { quantity: 20 },
        });

        await env.admin.patchAllotment(adminContext, VENDOR_A, DROP_2, { quantity: 20 });
        expect((await env.gate.check(env.batches[1]))!.covered).toBe(true);
    });

    it('has nothing to check for a vendor not assigned to the drop', async () => {
        const { gate } = build();
        expect(await gate.check(batchRow('b-x', VENDOR_B, DROP_1) as any)).toBeNull();
    });
});

describe('decideBatch enforces the allotment on ACCEPTED only', () => {
    const { SupplyService } = jest.requireActual('../src/service/supply.service');
    const row = batchRow('b-1', VENDOR_A, DROP_1, [{ variantId: RED_S, quantity: 20 }]);
    // Every unit has its chip — the manifest gate is tested separately below.
    row.lines[0]!.rowsReceived = 20;
    row.rowsReceived = 20;
    const make = (covered: boolean) => {
        const updateBatch = jest.fn(async (_id: string, data: any) => ({ ...row, ...data }));
        const service = new SupplyService({
            supply: { findBatchById: async () => row, updateBatch },
            eventBus,
            audit: NOOP_SUPPLY_AUDIT,
            logger,
            allotmentGate: { check: async () => ({ covered, suggestedPatch: null }) },
        });
        return { service, updateBatch };
    };

    it('refuses to accept an uncovered consignment and writes nothing', async () => {
        const { service, updateBatch } = make(false);
        await expect(
            service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' }),
        ).rejects.toMatchObject({ statusCode: 409, code: 'SUPPLY_ALLOTMENT_INSUFFICIENT' });
        expect(updateBatch).not.toHaveBeenCalled();
    });

    it('accepts once covered', async () => {
        const { service } = make(true);
        await expect(
            service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' }),
        ).resolves.toMatchObject({ status: 'ACCEPTED' });
    });

    it('never blocks a rejection', async () => {
        const { service } = make(false);
        await expect(
            service.decideBatch(adminContext, 'b-1', { status: 'REJECTED', note: 'over-produced' }),
        ).resolves.toMatchObject({ status: 'REJECTED' });
    });
});

describe('accepting takes the chips into stock', () => {
    const { SupplyService } = jest.requireActual('../src/service/supply.service');

    function complete() {
        const row = batchRow('b-1', VENDOR_A, DROP_1, [
            { variantId: RED_S, quantity: 2 },
            { variantId: RED_M, quantity: 2 },
        ]);
        for (const line of row.lines) line.rowsReceived = 2;
        row.rowsReceived = 4;
        row.status = 'VALIDATED';
        row.batchRef = 'SZ-1';
        return row;
    }

    function make(row: any, overrides: Record<string, any> = {}) {
        const mintBound = jest.fn(async (_tx: unknown, input: any) => ({
            minted: input.nfcTagIds.length,
            firstSerial: 1,
            lastSerial: input.nfcTagIds.length,
        }));
        const assertMintable = jest.fn(async () => { });
        const bindChipsToUnits = jest.fn(async () => 3);
        const supply = {
            lockBatchWithin: jest.fn(async () => ({
                status: row.status,
                quantity: row.quantity,
                rowsReceived: row.rowsReceived,
            })),
            lockDropWithin: jest.fn(async () => { }),
            findBatchById: async () => row,
            updateBatch: jest.fn(async (_id: string, data: any) => ({ ...row, ...data })),
            transaction: async (fn: any) => fn('tx'),
            findDropForMint: async () => ({ groupCode: 'TEE', totalSupply: 300 }),
            // One M chip failed QC, so it is not returned here.
            findChipsToStock: async () => [
                { id: 'chip-1', variantId: RED_S },
                { id: 'chip-2', variantId: RED_S },
                { id: 'chip-3', variantId: RED_M },
            ],
            bindChipsToUnits,
            updateBatchWithin: jest.fn(async (_tx: unknown, _id: string, data: any) => ({ ...row, ...data })),
            ...overrides,
        };
        const gate = { check: jest.fn(async () => ({ covered: true })) };
        const service = new SupplyService({
            supply,
            eventBus,
            audit: NOOP_SUPPLY_AUDIT,
            logger,
            allotmentGate: gate,
            stockMinter: { mintBound, assertMintable },
        });
        return { service, mintBound, assertMintable, bindChipsToUnits, supply, gate };
    }

    it('refuses to accept while any variant is missing chips', async () => {
        const row = complete();
        row.lines[1]!.rowsReceived = 1;
        const { service, mintBound } = make(row);
        await expect(
            service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' }),
        ).rejects.toMatchObject({
            code: 'SUPPLY_MANIFEST_INCOMPLETE',
            details: { lines: [expect.objectContaining({ variantId: RED_M, shortfall: 1 })] },
        });
        expect(mintBound).not.toHaveBeenCalled();
    });

    it('mints one unit per good chip, per variant, bound to its chip', async () => {
        const { service, mintBound, bindChipsToUnits, supply } = make(complete());
        const result = await service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' });

        expect(mintBound).toHaveBeenCalledTimes(2);
        expect(mintBound).toHaveBeenCalledWith('tx', expect.objectContaining({
            productId: DROP_1, variantId: RED_S, nfcTagIds: ['chip-1', 'chip-2'],
            vendorId: VENDOR_A, supplyBatchId: 'b-1', provisioningBatchId: 'SZ-1',
        }));
        expect(mintBound).toHaveBeenCalledWith('tx', expect.objectContaining({
            variantId: RED_M, nfcTagIds: ['chip-3'],
        }));
        expect(bindChipsToUnits).toHaveBeenCalledWith('tx', 'b-1');
        expect(supply.updateBatch).not.toHaveBeenCalled(); // status changed inside the transaction
        expect(result.status).toBe('ACCEPTED');
        expect(result.stock).toEqual({
            minted: 3,
            units: [
                { variantId: RED_S, count: 2, firstSerial: 1, lastSerial: 2 },
                { variantId: RED_M, count: 1, firstSerial: 1, lastSerial: 1 },
            ],
        });
    });

    it('checks release approval and variant rules for each variant group before minting', async () => {
        const { service, assertMintable, mintBound, supply } = make(complete());
        await service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' });

        expect(supply.lockBatchWithin).toHaveBeenCalledWith('tx', 'b-1');
        expect(supply.lockDropWithin).toHaveBeenCalledWith('tx', DROP_1);
        expect(assertMintable).toHaveBeenCalledWith({
            productId: DROP_1,
            groups: [{ variantId: RED_S, count: 2 }, { variantId: RED_M, count: 1 }],
        });
        expect(assertMintable.mock.invocationCallOrder[0]!).toBeLessThan(
            mintBound.mock.invocationCallOrder[0]!,
        );
    });

    it('refuses to accept a drop that has not cleared release approval', async () => {
        const { service, assertMintable, mintBound, supply } = make(complete());
        const notApproved = Object.assign(new Error('not approved'), {
            statusCode: 409,
            code: 'SKUS_NOT_APPROVED',
        });
        assertMintable.mockRejectedValueOnce(notApproved);

        await expect(
            service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' }),
        ).rejects.toMatchObject({ code: 'SKUS_NOT_APPROVED' });
        expect(mintBound).not.toHaveBeenCalled();
        expect(supply.updateBatchWithin).not.toHaveBeenCalled();
    });

    it('refuses to accept past a variant cap', async () => {
        const { service, assertMintable, mintBound } = make(complete());
        assertMintable.mockRejectedValueOnce(
            Object.assign(new Error('cap'), { statusCode: 409, code: 'PRODUCTS_VARIANT_SUPPLY_EXCEEDED' }),
        );
        await expect(
            service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' }),
        ).rejects.toMatchObject({ code: 'PRODUCTS_VARIANT_SUPPLY_EXCEEDED' });
        expect(mintBound).not.toHaveBeenCalled();
    });

    it('turns a double-clicked accept into a 409, not a second set of units', async () => {
        const row = complete();
        const { service, mintBound } = make(row, {
            lockBatchWithin: jest.fn(async () => ({ status: 'ACCEPTED', quantity: 4, rowsReceived: 4 })),
        });
        await expect(
            service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' }),
        ).rejects.toMatchObject({ code: 'SUPPLY_BATCH_STATE_INVALID' });
        expect(mintBound).not.toHaveBeenCalled();
    });

    it('re-checks the allotment inside the transaction', async () => {
        const { service, gate, mintBound } = make(complete());
        gate.check
            .mockResolvedValueOnce({ covered: true }) // the fast pre-check
            .mockResolvedValueOnce({ covered: false, suggestedPatch: null } as any); // after the lock
        await expect(
            service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' }),
        ).rejects.toMatchObject({ code: 'SUPPLY_ALLOTMENT_INSUFFICIENT' });
        expect(mintBound).not.toHaveBeenCalled();
    });

    it('retries when a concurrent mint takes the same serials', async () => {
        const { service, mintBound } = make(complete());
        mintBound.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
        const result = await service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' });
        expect(result.stock.minted).toBe(3);
    });

    it('gives up with a 409 after repeated collisions', async () => {
        const { service, mintBound } = make(complete());
        mintBound.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
        await expect(
            service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' }),
        ).rejects.toMatchObject({ code: 'SUPPLY_ACCEPT_CONFLICT' });
    });

    it('rolls back when the chips bound do not match the units minted', async () => {
        const { service, supply } = make(complete(), { bindChipsToUnits: jest.fn(async () => 2) });
        await expect(
            service.decideBatch(adminContext, 'b-1', { status: 'ACCEPTED' }),
        ).rejects.toMatchObject({ code: 'SUPPLY_ACCEPT_CONFLICT' });
        expect(supply.updateBatchWithin).not.toHaveBeenCalled();
    });

    it('mints nothing on VALIDATED', async () => {
        const row = complete();
        row.status = 'UPLOADED';
        const { service, mintBound } = make(row);
        await service.decideBatch(adminContext, 'b-1', { status: 'VALIDATED' });
        expect(mintBound).not.toHaveBeenCalled();
    });
});

describe('vendor chip upload waits for validation', () => {
    it('refuses a real upload while UPLOADED but allows a dry run', async () => {
        const env = build({ existingUserId: 'user-1' });
        await env.admin.inviteMember(adminContext, [], VENDOR_A, { email: 'v@a.test' });
        await env.admin.assignDrop(adminContext, VENDOR_A, { dropId: DROP_1, variants: RED_ALLOTMENT });
        const batch = await env.vendorPortal.createBatch(
            'user-1', 'c', createDto(DROP_1, [{ variantId: RED_S, quantity: 1 }]),
        );
        const rows = [{ uid: '04A1B2C3D4E5F6', variantId: RED_S }];

        await expect(
            env.vendorPortal.registerTags('user-1', 'c', batch.id, { tags: rows, dryRun: false } as any),
        ).rejects.toMatchObject({ code: 'SUPPLY_BATCH_NOT_VALIDATED' });
        await expect(
            env.vendorPortal.registerTags('user-1', 'c', batch.id, { tags: rows, dryRun: true } as any),
        ).resolves.toBeDefined();

        env.batches[0].status = 'VALIDATED';
        await expect(
            env.vendorPortal.registerTags('user-1', 'c', batch.id, { tags: rows, dryRun: false } as any),
        ).resolves.toBeDefined();
    });
});
