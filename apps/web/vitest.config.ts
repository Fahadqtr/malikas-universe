import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

/**
 * Vitest config for @malikas/web.
 *
 * The only thing this needs to do is teach Vitest the same `@/*` path alias
 * that Next.js / tsconfig use (baseUrl `.`), so tests can import route handlers
 * and libs that reference `@/lib/...`. Without it, importing the webhook route
 * (which does `import ... from '@/lib/whatsapp-signature'`) fails to resolve.
 *
 * No other test behaviour is changed (node environment is Vitest's default).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
