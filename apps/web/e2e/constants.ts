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

/**
 * Anúncios do seed (D-242). **O seed não criava nenhum** — os que existiam no
 * banco local eram resíduo da suíte de integração, e por isso `/anuncios`
 * chegou até aqui sem e2e nenhum: depois de um `db reset` a tela ficava vazia e
 * não havia o que afirmar.
 *
 * Os quatro cobrem exatamente os quatro estados que a faixa de resumo conta, e
 * o spec DERIVA as contagens desta lista — mudar uma linha muda os dois lados
 * juntos, como em `E2E_SKU_SALES`:
 *
 *   ativos = 3 · pausados = 1 · sem estoque = 1 · sem vínculo = 2
 *
 * O quarto existe por causa de D-122: vínculo POR VARIAÇÃO tem `sku_id` nulo no
 * anúncio e **não** é fila de trabalho. Se a contagem de "sem vínculo" um dia
 * voltar a ser `sku_id is null`, ela dirá 3 e o spec fica vermelho.
 */
export const E2E_LISTINGS = [
  {
    itemId: "MLB800000001",
    title: "Kit Relação E2E — vende e tem visita",
    status: "active",
    price: 189.9,
    available: 12,
    /** `listings.sku_id` preenchido: vínculo direto, a coluna SKU vira link. */
    vinculo: "sku",
  },
  {
    itemId: "MLB800000002",
    title: "Pastilha de Freio E2E — sem estoque",
    status: "active",
    price: 124.5,
    available: 0,
    vinculo: "nenhum",
  },
  {
    itemId: "MLB800000003",
    title: "Retrovisor E2E — pausado",
    status: "paused",
    price: 96,
    available: 5,
    vinculo: "nenhum",
  },
  {
    itemId: "MLB800000004",
    title: "Guidão E2E — vínculo por variação",
    status: "active",
    price: 240,
    available: 3,
    /** Linha em `sku_listing_links` com `variation_id`, `listings.sku_id` NULO. */
    vinculo: "variacao",
  },
] as const;

/**
 * Tráfego e venda do PRIMEIRO anúncio, e só dele.
 *
 * O segundo fica deliberadamente sem visita: é o que prova na tela a regra de
 * D-123 — sem denominador a conversão é "—", **indefinida, não 0%**. Um seed
 * que desse visita a todos apagaria a única evidência visual dessa distinção.
 *
 * `daysAgo` relativo a hoje pelo mesmo motivo de `E2E_SKU_SALES`: a janela da
 * tela é de 30 dias e data fixa sairia dela em silêncio.
 */
export const E2E_LISTING_TRAFFIC = {
  itemId: "MLB800000001",
  daysAgo: 1,
  visits: 250,
  units: 8,
  revenue: 1519.2,
  orders: 8,
} as const;
