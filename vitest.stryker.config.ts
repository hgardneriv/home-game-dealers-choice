import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config used only by Stryker mutation runs. Identical to the normal
 * config except the fuzz suite is excluded: 150 seeded games (~23s) per
 * surviving mutant would dominate the run. The scenario/unit tests are the
 * mutation-killing layer; fuzz stays the invariant safety net in `npm test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/engine/fuzz.test.ts'],
  },
});
