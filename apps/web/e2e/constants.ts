/**
 * Constantes compartilhadas entre `seed.ts` e os specs — separadas do seed
 * porque `seed.ts` roda `main()` no top level (é um script, não um módulo
 * para importar): importar dele para pegar só a credencial re-executaria o
 * seed inteiro a cada spec.
 */
export const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? "e2e@speedbikers.test";
export const E2E_USER_PASSWORD = process.env.E2E_USER_PASSWORD ?? "SpeedBikersE2E!2026";

/**
 * Vendas do SKU do seed (aba Vendas, D-227) — dois dias, uma conta. O spec
 * recalcula os totais a partir DAQUI, então mudar um número muda os dois
 * lados juntos. `daysAgo` relativo a hoje porque a aba tem janela fixa de
 * 30 dias: uma data fixa envelheceria e sairia da janela em silêncio (a
 * mesma armadilha que D-204 encontrou num fixture com `captured_at` fixo).
 */
export const E2E_SKU_SALES = [
  { daysAgo: 1, units: 3, revenue: 300, orders: 3, purchases: 3 },
  { daysAgo: 3, units: 2, revenue: 200, orders: 2, purchases: 2 },
] as const;

/** Texto da decisão do seed (aba Decisões, D-228) — o spec procura por ele. */
export const E2E_DECISION_TEXT = "Repor 10 unidades e revisar o preço — decisão de teste E2E";
