import { defineConfig } from '@playwright/test';

/**
 * E2E smoke tests — real gameplay in a real browser. Run headed to watch:
 *   npm run test:e2e        (headed, slowed down for humans)
 *   npm run test:e2e:ci     (headless, full speed)
 * Reuses a running `next dev` on :3000, or boots one for the run.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  // Game flows are stateful — one worker, no retries (a retry would join a
  // half-played table).
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
