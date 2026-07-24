// apps/backend/src/index.ts
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

//Load root env FIRST — nothing app-related is imported yet.
// .env.local wins (local overrides); .env is the fallback. dotenv does not
// overwrite vars already set by an earlier call, so order = precedence.
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../../');
config({ path: resolve(root, '.env.local') });
config({ path: resolve(root, '.env') });


await import('./server');