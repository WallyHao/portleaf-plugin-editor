import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', 'json'],
    outputFile: { json: 'test-results/vitest.json' },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/test/unit/**/*.test.ts'],
          testTimeout: 15_000,
          restoreMocks: true,
          unstubGlobals: true,
          unstubEnvs: true,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['{apps,packages}/*/test/integration/**/*.integration.test.ts'],
          testTimeout: 15_000,
          restoreMocks: true,
          unstubGlobals: true,
          unstubEnvs: true,
        },
      },
    ],
  },
});
