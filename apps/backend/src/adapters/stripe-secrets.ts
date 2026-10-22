/**
 * Resolves `PaymentGatewayConfig.credentialsRef` to a Stripe secret key.
 *
 * Lives at the composition root for the same reason as the tag cipher: the key
 * belongs to the deployment, and the database only ever holds a pointer to it.
 * This deployment's "secrets manager" is the process environment:
 *
 *   env:NAME                  → the variable NAME (STRIPE_* names only)
 *   secrets://stripe/<name>   → STRIPE_SECRET_KEY_<NAME>, falling back to
 *                               STRIPE_SECRET_KEY
 *
 * So `secrets://stripe/platform` reads STRIPE_SECRET_KEY_PLATFORM or
 * STRIPE_SECRET_KEY, and an organization on its own Stripe account
 * (`secrets://stripe/ronin`) gets its own variable without code changes. A
 * real secrets manager replaces this one function.
 *
 * Keys are read here and nowhere else — deliberately not declared in the env
 * schema, so they never appear in its validation report.
 *
 * Outside production a live key (`sk_live_…`/`rk_live_…`) is refused: a dev
 * box pressing "Process" on seeded data must not be able to send real money.
 */
export interface StripeSecrets {
    /** True if any Stripe key is present — the adapter is wired only then. */
    configured: boolean;
    resolve(credentialsRef: string): string | undefined;
}

export function createStripeSecrets(
    env: { NODE_ENV: string },
    source: NodeJS.ProcessEnv = process.env,
    warn: (message: string) => void = () => undefined,
): StripeSecrets {
    const allowLive = env.NODE_ENV === 'production';

    const read = (name: string): string | undefined => {
        const value = source[name]?.trim();
        if (!value) return undefined;
        if (!allowLive && /^(sk|rk)_live_/.test(value)) {
            warn(`${name} holds a live Stripe key; refused outside production.`);
            return undefined;
        }
        return value;
    };

    return {
        configured: Object.keys(source).some(
            (name) => (name === 'STRIPE_SECRET_KEY' || name.startsWith('STRIPE_SECRET_KEY_')) && Boolean(source[name]),
        ),
        resolve(credentialsRef) {
            // Only STRIPE_* names: a ref is typed by an admin, and must not be
            // able to send DATABASE_URL to Stripe as a bearer token.
            if (credentialsRef.startsWith('env:')) {
                const name = credentialsRef.slice(4);
                return /^STRIPE_[A-Z0-9_]+$/.test(name) ? read(name) : undefined;
            }
            const match = /^secrets:\/\/stripe\/([A-Za-z0-9_-]+)$/.exec(credentialsRef);
            if (!match) return undefined;
            const suffix = match[1]!.toUpperCase().replace(/-/g, '_');
            return read(`STRIPE_SECRET_KEY_${suffix}`) ?? read('STRIPE_SECRET_KEY');
        },
    };
}
