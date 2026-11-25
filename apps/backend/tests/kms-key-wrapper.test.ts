import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLocalKeyWrapper, localWrapAllowedInProduction } from '../src/adapters/kms-key-wrapper';

/**
 * The local key wrapper is development-only. Production refuses it unless the
 * deployment opts in explicitly, and only the literal "true" counts.
 */

const SECRET = 'a'.repeat(64);
const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

describe('createLocalKeyWrapper', () => {
    it('builds in development with a wrap key, and round-trips a key', async () => {
        const wrapper = createLocalKeyWrapper({ NODE_ENV: 'development', NFC_LOCAL_WRAP_KEY: SECRET });
        assert.ok(wrapper);
        const wrapped = await wrapper.wrap(KEY, 'local-dev');
        assert.notDeepEqual(wrapped.subarray(-16), KEY);
        assert.deepEqual(await wrapper.unwrap(wrapped, 'local-dev'), KEY);
    });

    it('is undefined with no wrap key', () => {
        assert.equal(createLocalKeyWrapper({ NODE_ENV: 'development' }), undefined);
    });

    it('refuses to be created in production by default', () => {
        assert.throws(
            () => createLocalKeyWrapper({ NODE_ENV: 'production', NFC_LOCAL_WRAP_KEY: SECRET }),
            /must not run in production/,
        );
    });

    it('refuses in production for anything but the literal "true"', () => {
        for (const value of ['TRUE', '1', 'yes', 'false', '', ' true']) {
            assert.throws(
                () =>
                    createLocalKeyWrapper({
                        NODE_ENV: 'production',
                        NFC_LOCAL_WRAP_KEY: SECRET,
                        NFC_ALLOW_LOCAL_WRAP_IN_PRODUCTION: value,
                    }),
                /must not run in production/,
                `"${value}" must not count as opting in`,
            );
        }
    });

    it('runs in production when the deployment opts in with "true", and still wraps properly', async () => {
        const wrapper = createLocalKeyWrapper({
            NODE_ENV: 'production',
            NFC_LOCAL_WRAP_KEY: SECRET,
            NFC_ALLOW_LOCAL_WRAP_IN_PRODUCTION: 'true',
        });
        assert.ok(wrapper);
        const wrapped = await wrapper.wrap(KEY, 'local-dev');
        assert.deepEqual(await wrapper.unwrap(wrapped, 'local-dev'), KEY);
        // Bound to its reference: a blob cannot be unwrapped under another one.
        await assert.rejects(() => wrapper.unwrap(wrapped, 'another-ref'));
    });

    it('opted in but no wrap key: undefined, so registration stays a 503, never a silent bare key', () => {
        assert.equal(
            createLocalKeyWrapper({ NODE_ENV: 'production', NFC_ALLOW_LOCAL_WRAP_IN_PRODUCTION: 'true' }),
            undefined,
        );
    });
});

describe('localWrapAllowedInProduction', () => {
    it('is true only for the literal "true"', () => {
        assert.equal(localWrapAllowedInProduction({ NFC_ALLOW_LOCAL_WRAP_IN_PRODUCTION: 'true' }), true);
        assert.equal(localWrapAllowedInProduction({}), false);
        assert.equal(localWrapAllowedInProduction({ NFC_ALLOW_LOCAL_WRAP_IN_PRODUCTION: 'True' }), false);
    });
});
