/**
 * Constantes compartilhadas entre `seed.ts` e os specs — separadas do seed
 * porque `seed.ts` roda `main()` no top level (é um script, não um módulo
 * para importar): importar dele para pegar só a credencial re-executaria o
 * seed inteiro a cada spec.
 */
export const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? "e2e@speedbikers.test";
export const E2E_USER_PASSWORD = process.env.E2E_USER_PASSWORD ?? "SpeedBikersE2E!2026";
