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
      // Test-only VAPID key (never used outside cloud:test); push tests also cover its absence.
      VAPID_PRIVATE_KEY: JSON.stringify({ kty: 'EC', crv: 'P-256', x: '-VNa-PIgkr6ihs0VFqWVJuNMOmzJ4TNZPlXXwJjTHFM', y: 'TlS_M8Yei5OmVwnmYfgCWwKtjTjopMJCZ3jOv8nrqhE', d: 'lF9TDnasE9ScJfas1Gn_Wi_dgYX7JheLdGEgnknG6Gc' }),
    } },
  })],
  test: { include: ['cloud/tests/**/*.test.ts'], testTimeout: 10_000, hookTimeout: 20_000 },
});
