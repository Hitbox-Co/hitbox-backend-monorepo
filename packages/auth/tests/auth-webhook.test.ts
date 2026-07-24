// svix signature verification is mocked — we test dedup/dispatch, not crypto.
// `mock`-prefixed names are the only vars a jest.mock factory may reference.
const mockVerify = jest.fn();
jest.mock('svix', () => ({ Webhook: jest.fn(() => ({ verify: mockVerify })) }));

import { AuthWebhookService } from '../src/service/auth-webhook.service';
import { AUTH_EVENTS } from '../src/constants/auth.constant';

const HEADERS = {
    'svix-id': 'msg_123',
    'svix-timestamp': '1700000000',
    'svix-signature': 'v1,deadbeef',
};

const CREATED_ENVELOPE = {
    type: 'user.created',
    data: {
        id: 'user_1',
        email_addresses: [
            { id: 'e1', email_address: 'buyer@example.com', verification: { status: 'verified' } },
        ],
        primary_email_address_id: 'e1',
    },
};

function makeService(hasProcessed: boolean[] | boolean) {
    const seq = Array.isArray(hasProcessed) ? [...hasProcessed] : null;
    const webhookEvents = {
        hasProcessed: jest.fn().mockImplementation(async () =>
            seq ? (seq.shift() ?? false) : hasProcessed,
        ),
        markProcessed: jest.fn().mockResolvedValue(undefined),
    };
    const eventBus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = new AuthWebhookService({
        webhookEvents: webhookEvents as never,
        eventBus: eventBus as never,
        signingSecret: 'whsec_dummy',
        logger: logger as never,
    });
    return { service, webhookEvents, eventBus };
}

beforeEach(() => {
    mockVerify.mockReset();
    mockVerify.mockReturnValue(CREATED_ENVELOPE);
});

describe('AuthWebhookService.processClerkWebhook', () => {
    it('processes a first delivery: publishes the domain event and records it', async () => {
        const { service, eventBus, webhookEvents } = makeService(false);
        await service.processClerkWebhook(JSON.stringify(CREATED_ENVELOPE), HEADERS);

        expect(eventBus.publish).toHaveBeenCalledTimes(1);
        expect(eventBus.publish).toHaveBeenCalledWith(
            AUTH_EVENTS.USER_REGISTERED,
            expect.objectContaining({ clerkUserId: 'user_1', email: 'buyer@example.com', emailVerified: true }),
        );
        expect(webhookEvents.markProcessed).toHaveBeenCalledTimes(1);
    });

    it('is idempotent: a duplicate svix-id is ignored (no second publish/record)', async () => {
        const { service, eventBus, webhookEvents } = makeService([false, true]);

        await service.processClerkWebhook(JSON.stringify(CREATED_ENVELOPE), HEADERS);
        await service.processClerkWebhook(JSON.stringify(CREATED_ENVELOPE), HEADERS); // replay

        expect(eventBus.publish).toHaveBeenCalledTimes(1);
        expect(webhookEvents.markProcessed).toHaveBeenCalledTimes(1);
    });

    it('rejects a bad signature with AUTH_WEBHOOK_INVALID_SIGNATURE', async () => {
        const { service } = makeService(false);
        mockVerify.mockImplementation(() => {
            throw new Error('bad signature');
        });
        await expect(
            service.processClerkWebhook('{}', HEADERS),
        ).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_WEBHOOK_INVALID_SIGNATURE' });
    });

    it('rejects missing svix headers', async () => {
        const { service } = makeService(false);
        await expect(
            service.processClerkWebhook('{}', { 'svix-id': 'x' }),
        ).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_WEBHOOK_INVALID_SIGNATURE' });
    });

    it('marks unverified email in the published payload', async () => {
        const { service, eventBus } = makeService(false);
        mockVerify.mockReturnValue({
            type: 'user.created',
            data: {
                id: 'user_2',
                email_addresses: [
                    { id: 'e1', email_address: 'pending@example.com', verification: { status: 'unverified' } },
                ],
                primary_email_address_id: 'e1',
            },
        });
        await service.processClerkWebhook('{}', HEADERS);
        expect(eventBus.publish).toHaveBeenCalledWith(
            AUTH_EVENTS.USER_REGISTERED,
            expect.objectContaining({ emailVerified: false }),
        );
    });
});
