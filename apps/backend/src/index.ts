// apps/backend/src/index.ts
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

//Load the root .env FIRST — nothing app-related is imported yet.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });


await import('./server');