import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      HOST_TOKEN: 'foreman-test-host-token-that-is-not-a-production-secret',
      FIREBASE_PROJECT_ID: 'foreman-test-project',
      ALLOWED_EMAIL: 'owner@example.com',
      FIREBASE_CONFIG: JSON.stringify({ projectId: 'foreman-test-project', apiKey: 'public-test-key' }),
    } },
  })],
  test: { include: ['cloud/tests/**/*.test.ts'], testTimeout: 10_000, hookTimeout: 20_000 },
});
