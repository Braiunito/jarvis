import { defineConfig, devices } from '@playwright/test';

/**
 * Los cinco flujos críticos, en escritorio y en móvil.
 *
 * El stack entero se levanta contra hosts falsos: es la única forma de probar durabilidad de
 * verdad —tmux, spool, reinicios— sin depender de un bastión que puede no estar.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env['CI'] ? [['list'], ['json', { outputFile: 'evidence/e2e-report.json' }]] : 'list',
  use: {
    baseURL: process.env['JARVIS_E2E_URL'] ?? 'http://127.0.0.1:8099',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'escritorio', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'movil', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'node scripts/e2e-stack.mjs',
    url: 'http://127.0.0.1:8099/healthz',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
