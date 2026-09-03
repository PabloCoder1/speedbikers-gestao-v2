/**
 * Constantes compartilhadas entre `seed.ts` e os specs — separadas do seed
 * porque `seed.ts` roda `main()` no top level (é um script, não um módulo
 * para importar): importar dele para pegar só a credencial re-executaria o
 * seed inteiro a cada spec.
 */
export const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? "e2e@speedbikers.test";
export const E2E_USER_PASSWORD = process.env.E2E_USER_PASSWORD ?? "SpeedBikersE2E!2026";

/**
 * Segundo usuário do seed, GESTOR (D-232) — credenciais prontas, mas o seed
 * AINDA NÃO o cria. Ao criá-lo, 9 dos 19 e2e caíram: as ~25 telas que leem
 * `organization_members` com `maybeSingle()` sem filtro por usuário recebem
 * PGRST116 no segundo membro e mostram "sem organização". É a prova do defeito
 * que a revisão de D-231 previu (ver `lib/membership.ts`); a migração dessas
 * leituras é fatia própria, e o seed passa a criar este usuário nela.
 */
export const E2E_GESTOR_EMAIL = process.env.E2E_GESTOR_EMAIL ?? "gestor@speedbikers.test";
export const E2E_GESTOR_PASSWORD = process.env.E2E_GESTOR_PASSWORD ?? "SpeedBikersGestor!2026";

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
