import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    server: {
      deps: {
        // `node:sqlite` is a Node builtin that this version of Vite does not
        // yet recognise, so it tries to bundle it. Externalising it hands the
        // import back to Node, which resolves it natively.
        external: [/^node:sqlite$/],
      },
    },
  },
  ssr: {
    external: ['node:sqlite'],
  },
  optimizeDeps: {
    exclude: ['node:sqlite'],
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.json'],
  },
});
