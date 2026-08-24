import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright "a partir da Fase 5, apenas nos fluxos críticos" (docs/TESTING.md
 * secao 3) — por isso um projeto só (Chromium) e um worker só: a suíte inteira
 * compartilha a MESMA organização/usuário seedados (`e2e/seed.ts`), e alguns
 * specs mutam estado real (vínculo de item de NF-e) — rodar em paralelo
 * arriscaria uma corrida entre testes, não entre features.
 *
 * Roda SOMENTE contra Supabase local (`supabase start`), nunca Dev/produção
 * — ver `e2e/seed.ts`.
 */
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // `next start` exige build prévio (`pnpm run build`) — a esteira de CI faz
  // isso num passo separado, depois de subir o Supabase local, porque as
  // variáveis NEXT_PUBLIC_* são embutidas NO BUILD, não em runtime.
  webServer: {
    command: "pnpm run start",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: process.env.CI === undefined,
    timeout: 60_000,
  },
});
