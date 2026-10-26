import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@hitbox/database';
import { AppError } from '@hitbox/shared';
import {
    PAYMENTS_ERROR_CODES,
    PAYMENT_EVENTS,
    RETURN_DESCRIPTION_MIN_LENGTH,
} from '../src/constants/payments.constant';
import type { ReturnEvidenceAsset } from '../src/domain/interfaces/return-evidence.interface';
import type { PaymentAccess } from '../src/domain/payment-access';
import { requestRefundSchema } from '../src/dto/payments.dto';
import { RefundService } from '../src/service/refund.service';

/**
 * A buyer placing a return must attach photos and describe the problem.
 * docs/orders/order-payments-and-refunds-api.md §6.0–6.1
 */

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

const BUYER = 'buyer-1';
const ORDER = '11111111-1111-4111-8111-111111111111';
const OTHER_ORDER = '22222222-2222-4222-8222-222222222222';
const PHOTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHOTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DESCRIPTION = 'The NFC tag will not scan and the sleeve seam is split.';
const NOW = new Date('2026-10-23T12:00:00Z');
const daysBefore = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const buyerAccess: PaymentAccess = {
    userId: BUYER, scope: 'OWN', organizationIds: [],
    canManage: false, canConfigure: false, canRefund: false,
};
const supportAccess: PaymentAccess = {
    userId: 'support-1', scope: 'GLOBAL', organizationIds: null,
    canManage: false, canConfigure: false, canRefund: true,
};

function photo(id: string, over: Partial<ReturnEvidenceAsset> = {}): ReturnEvidenceAsset {
    return { id, orderId: ORDER, uploadedById: BUYER, archived: false, infected: false, uploaded: true, ...over };
}

function build(opts: {
    order?: Record<string, unknown> | null;
    photos?: ReturnEvidenceAsset[];
    attached?: string[];
    noMedia?: boolean;
    createError?: unknown;
} = {}) {
    const order = opts.order === undefined
        ? { orderId: ORDER, buyerId: BUYER, status: 'DELIVERED', organizationId: null, skuId: 's1', claimId: null, amount: '2499.00', currency: 'INR', gateway: 'STRIPE', deliveredAt: daysBefore(2) }
        : opts.order;
    const refunds = {
        findOpenForOrder: jest.fn(async () => null),
        refundedTotal: jest.fn(async () => new Prisma.Decimal(0)),
        findAttachedAssetIds: jest.fn(async () => opts.attached ?? []),
        create: jest.fn(async (data: Record<string, unknown>, evidence: { mediaAssetIds: string[] }) => {
            if (opts.createError) throw opts.createError;
            return {
                ...data,
                amount: data.amount,
                physicalReturnConfirmedAt: null, nfcTagCondition: null, approvedById: null, approvedAt: null,
                rejectionReason: null, gatewayRefundId: null, gatewayStatus: null, gatewayFailureReason: null,
                gatewayStatusAt: null, processedAt: null, claimRevokedAt: null, resaleBlockedUntil: null,
                _count: { evidence: evidence.mediaAssetIds.length },
            };
        }),
        findEvidence: jest.fn(async () => [
            { mediaAssetId: PHOTO_A, position: 0, createdAt: new Date('2026-10-23T10:00:00Z') },
        ]),
    };
    const media = {
        createUpload: jest.fn(async () => ({
            assetId: PHOTO_A, uploadUrl: 'https://s3/put', expiresIn: 300,
            requiredHeaders: { 'Content-Type': 'image/jpeg' as const },
        })),
        inspect: jest.fn(async () => opts.photos ?? [photo(PHOTO_A)]),
        viewFiles: jest.fn(async () => [
            { assetId: PHOTO_A, fileName: 'tag.jpg', mimeType: 'image/jpeg', sizeBytes: 1000, url: 'https://s3/get', expiresIn: 300 },
        ]),
    };
    const eventBus = { publish: jest.fn(async () => undefined) };
    const service = new RefundService({
        refunds: refunds as never,
        payments: {} as never,
        gatewayConfigs: {} as never,
        orders: { findOrderSummary: jest.fn(async () => order) } as never,
        finance: {} as never,
        royalties: {} as never,
        claims: {} as never,
        evidence: opts.noMedia ? undefined : (media as never),
        returnWindowDays: 10,
        now: () => NOW,
        eventBus: eventBus as never,
        audit: { record: jest.fn(), emit: jest.fn() } as never,
        logger: silentLogger,
    });
    return { service, refunds, media, eventBus };
}

const dto = (over: Record<string, unknown> = {}) =>
    requestRefundSchema.parse({
        orderId: ORDER,
        reasonCode: 'DEFECTIVE_TAG',
        reason: DESCRIPTION,
        evidenceAssetIds: [PHOTO_A],
        ...over,
    });

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof AppError) return error;
        throw error;
    }
    throw new Error('expected the call to fail');
}

describe('placing a return — what the buyer must supply', () => {
    it('creates the return with its photos, in order, and returns them with URLs', async () => {
        const { service, refunds, eventBus } = build({ photos: [photo(PHOTO_A), photo(PHOTO_B)] });
        const view = await service.request(dto({ evidenceAssetIds: [PHOTO_A, PHOTO_B] }), BUYER, buyerAccess);

        expect(refunds.create).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'AWAITING_RETURN', physicalReturnRequired: true }),
            { mediaAssetIds: [PHOTO_A, PHOTO_B], attachedById: BUYER },
        );
        expect(view.evidence).toEqual([
            expect.objectContaining({ assetId: PHOTO_A, position: 0, url: 'https://s3/get', expiresIn: 300 }),
        ]);
        expect(eventBus.publish).toHaveBeenCalledWith(
            PAYMENT_EVENTS.REFUND_REQUESTED,
            expect.objectContaining({ evidenceCount: 2 }),
        );
    });

    it('refuses a return with no photos', async () => {
        const { service, refunds } = build();
        const error = await errorOf(service.request(dto({ evidenceAssetIds: [] }), BUYER, buyerAccess));
        expect(error.statusCode).toBe(400);
        expect(error.code).toBe(PAYMENTS_ERROR_CODES.RETURN_EVIDENCE_REQUIRED);
        expect(refunds.create).not.toHaveBeenCalled();
    });

    it('refuses a description shorter than the minimum, measured after trimming', async () => {
        const { service } = build();
        const padded = `   ${'x'.repeat(RETURN_DESCRIPTION_MIN_LENGTH - 1)}   `;
        const error = await errorOf(service.request(dto({ reason: padded }), BUYER, buyerAccess));
        expect(error.code).toBe(PAYMENTS_ERROR_CODES.RETURN_DESCRIPTION_TOO_SHORT);
        expect(error.details).toEqual({ minLength: RETURN_DESCRIPTION_MIN_LENGTH, length: RETURN_DESCRIPTION_MIN_LENGTH - 1 });
    });

    it('needs neither photos nor a long description when nothing is being sent back', async () => {
        const { service, media } = build();
        await service.request(
            dto({ reasonCode: 'NOT_DELIVERED', reason: 'Never came.', physicalReturnRequired: false, evidenceAssetIds: [] }),
            BUYER,
            buyerAccess,
        );
        expect(media.inspect).not.toHaveBeenCalled();
    });

    it('lets support raise a return on a buyer’s behalf without photos', async () => {
        const { service, refunds } = build();
        await service.request(dto({ reason: 'Phoned in.', evidenceAssetIds: [] }), 'support-1', supportAccess);
        expect(refunds.create).toHaveBeenCalled();
    });

    it('cannot accept a return on a deployment with no media storage', async () => {
        const { service } = build({ noMedia: true });
        const error = await errorOf(service.request(dto(), BUYER, buyerAccess));
        expect(error.code).toBe(PAYMENTS_ERROR_CODES.EVIDENCE_STORAGE_UNAVAILABLE);
    });
});

describe('placing a return — which photos are acceptable', () => {
    it.each<[string, Partial<ReturnEvidenceAsset>, string]>([
        ['uploaded by someone else (reported as not found, so ids cannot be probed)', { uploadedById: 'someone-else' }, 'NOT_FOUND'],
        ['issued for a different order', { orderId: OTHER_ORDER }, 'WRONG_ORDER'],
        ['never actually PUT to storage', { uploaded: false }, 'NOT_UPLOADED'],
        ['archived', { archived: true }, 'ARCHIVED'],
        ['flagged by the scanner', { infected: true }, 'REJECTED_BY_SCAN'],
    ])('refuses a photo %s', async (_label, over, problem) => {
        const { service, refunds } = build({ photos: [photo(PHOTO_A, over)] });
        const error = await errorOf(service.request(dto(), BUYER, buyerAccess));
        expect(error.code).toBe(PAYMENTS_ERROR_CODES.RETURN_EVIDENCE_INVALID);
        expect(error.details).toEqual({ problems: [{ assetId: PHOTO_A, problem }] });
        expect(refunds.create).not.toHaveBeenCalled();
    });

    it('reports every bad photo at once, and an unknown id as not found', async () => {
        const { service } = build({ photos: [photo(PHOTO_A, { uploaded: false })] });
        const error = await errorOf(service.request(dto({ evidenceAssetIds: [PHOTO_A, PHOTO_B] }), BUYER, buyerAccess));
        expect(error.details).toEqual({
            problems: [
                { assetId: PHOTO_A, problem: 'NOT_UPLOADED' },
                { assetId: PHOTO_B, problem: 'NOT_FOUND' },
            ],
        });
    });

    it('refuses a photo already backing another return', async () => {
        const { service } = build({ attached: [PHOTO_A] });
        const error = await errorOf(service.request(dto(), BUYER, buyerAccess));
        expect(error.details).toEqual({ problems: [{ assetId: PHOTO_A, problem: 'ALREADY_ATTACHED' }] });
    });

    it('turns losing the race for a photo into a 409, not a 500', async () => {
        const race = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        const { service } = build({ createError: race });
        const error = await errorOf(service.request(dto(), BUYER, buyerAccess));
        expect(error.statusCode).toBe(409);
        expect(error.code).toBe(PAYMENTS_ERROR_CODES.RETURN_EVIDENCE_INVALID);
    });

    it('rejects the same photo listed twice, and more than eight, at the schema', () => {
        expect(() => dto({ evidenceAssetIds: [PHOTO_A, PHOTO_A] })).toThrow('listed twice');
        const nine = Array.from({ length: 9 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`);
        expect(() => dto({ evidenceAssetIds: nine })).toThrow('At most 8');
    });
});

describe('POST /refunds/evidence/upload-url', () => {
    const upload = { orderId: ORDER, fileName: 'tag.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 };

    it('issues an upload for the buyer’s own refundable order', async () => {
        const { service, media } = build();
        const view = await service.createEvidenceUpload(upload, BUYER, buyerAccess);
        expect(media.createUpload).toHaveBeenCalledWith({ ...upload, uploadedById: BUYER });
        expect(view).toEqual(expect.objectContaining({ assetId: PHOTO_A, requiredHeaders: { 'Content-Type': 'image/jpeg' } }));
    });

    it('refuses another buyer’s order', async () => {
        const { service, media } = build();
        const error = await errorOf(service.createEvidenceUpload(upload, 'buyer-2', { ...buyerAccess, userId: 'buyer-2' }));
        expect(error.statusCode).toBe(403);
        expect(media.createUpload).not.toHaveBeenCalled();
    });

    it('refuses an order that cannot be refunded, before any photo is taken', async () => {
        const { service, media } = build({
            order: { orderId: ORDER, buyerId: BUYER, status: 'PENDING_PAYMENT', organizationId: null, skuId: null, claimId: null, amount: '1.00', currency: 'INR', gateway: 'STRIPE' },
        });
        const error = await errorOf(service.createEvidenceUpload(upload, BUYER, buyerAccess));
        expect(error.code).toBe(PAYMENTS_ERROR_CODES.NOT_REFUNDABLE);
        expect(media.createUpload).not.toHaveBeenCalled();
    });

    it('404s an unknown order', async () => {
        const { service } = build({ order: null });
        const error = await errorOf(service.createEvidenceUpload(upload, BUYER, buyerAccess));
        expect(error.statusCode).toBe(404);
    });
});

describe('the 10-day return window', () => {
    const delivered = (days: number | null) => ({
        orderId: ORDER, buyerId: BUYER, status: 'DELIVERED', organizationId: null, skuId: 's1', claimId: null,
        amount: '2499.00', currency: 'INR', gateway: 'STRIPE', deliveredAt: days === null ? null : daysBefore(days),
    });
    const upload = { orderId: ORDER, fileName: 'tag.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 };

    it('accepts a return up to the last moment of day 10', async () => {
        const { service, refunds } = build({ order: { ...delivered(0), deliveredAt: new Date(NOW.getTime() - 10 * 86_400_000 + 1) } });
        await service.request(dto(), BUYER, buyerAccess);
        expect(refunds.create).toHaveBeenCalled();
    });

    it('refuses a return once 10 days have passed since delivery, with the dates', async () => {
        const { service, refunds } = build({ order: delivered(10) });
        const error = await errorOf(service.request(dto(), BUYER, buyerAccess));
        expect(error.code).toBe(PAYMENTS_ERROR_CODES.RETURN_WINDOW_CLOSED);
        expect(error.details).toEqual({
            deliveredAt: daysBefore(10).toISOString(), returnWindowEndsAt: NOW.toISOString(), returnWindowDays: 10,
        });
        expect(refunds.create).not.toHaveBeenCalled();
    });

    it('refuses the photo upload too, before any photo is taken', async () => {
        const { service, media } = build({ order: delivered(11) });
        const error = await errorOf(service.createEvidenceUpload(upload, BUYER, buyerAccess));
        expect(error.code).toBe(PAYMENTS_ERROR_CODES.RETURN_WINDOW_CLOSED);
        expect(media.createUpload).not.toHaveBeenCalled();
    });

    it('stops a buyer dodging it with a no-return refund', async () => {
        const { service } = build({ order: delivered(30) });
        const error = await errorOf(service.request(
            dto({ physicalReturnRequired: false, evidenceAssetIds: [], reasonCode: 'OTHER', reason: 'Keep it, refund me.' }),
            BUYER, buyerAccess,
        ));
        expect(error.code).toBe(PAYMENTS_ERROR_CODES.RETURN_WINDOW_CLOSED);
    });

    it('stops staff placing a return after it closes — there is no override', async () => {
        const { service } = build({ order: delivered(30) });
        const error = await errorOf(service.request(dto({ evidenceAssetIds: [] }), 'support-1', supportAccess));
        expect(error.code).toBe(PAYMENTS_ERROR_CODES.RETURN_WINDOW_CLOSED);
    });

    it('still lets staff issue a goodwill refund with nothing sent back', async () => {
        const { service, refunds } = build({ order: delivered(30) });
        await service.request(
            dto({ physicalReturnRequired: false, evidenceAssetIds: [], reasonCode: 'OTHER', reason: 'Goodwill.' }),
            'support-1', supportAccess,
        );
        expect(refunds.create).toHaveBeenCalled();
    });

    it('has not started for an order not yet delivered', async () => {
        const { service, refunds } = build({ order: { ...delivered(null), status: 'SHIPPED' } });
        await service.request(dto(), BUYER, buyerAccess);
        expect(refunds.create).toHaveBeenCalled();
    });
});
