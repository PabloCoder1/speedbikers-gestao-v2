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

/** Full DO ANÚNCIO do primeiro anúncio (D-243) — o único com snapshot no seed. */
export const E2E_LISTING_FULL = 3;

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

/**
 * Uma mudança de preço observada no primeiro anúncio (D13). O Dashboard do
 * Anúncio tem abas de Preço e Histórico que só existem se houver evento de
 * domínio — e o seed não criava nenhum, então as duas abas nasceriam vazias e
 * não haveria o que afirmar (a mesma lição de D-242 e da auditoria A1).
 */
export const E2E_LISTING_PRICE_EVENT = { de: 199.9, para: 189.9 } as const;

/**
 * Uma republicação do primeiro anúncio, em estado terminal de falha. Falha é o
 * estado que a tela precisa mostrar bem — o motivo aparece na tabela —, e é o
 * único que não exige inventar um anúncio filho.
 */
export const E2E_LISTING_RELIST = {
  status: "PREFLIGHT_FAILED",
  failureReason: "Anúncio com venda nos últimos 60 dias — republicação não recomendada.",
} as const;

/** Texto da decisão sobre a ação DO ANÚNCIO (aba Decisões, D13). */
export const E2E_LISTING_DECISION_TEXT = "Manter o preço e observar visitas por mais 7 dias — decisão de teste E2E";

/**
 * Fornecedor e pedidos de compra da fila de `/compras` (D19, D-255).
 *
 * **O seed não criava pedido nenhum, e a justificativa estava escrita:** *"não
 * precisa de seed: o formulário de `/compras/novo` aceita SKU em texto livre"*.
 * Era verdade enquanto o teste exercitava a CRIAÇÃO. Deixa de ser quando a
 * fatia é a LISTA — filtro por estado, contagem, janela paginada e a coluna de
 * valor não têm o que afirmar com um pedido só, criado pelo próprio teste.
 *
 * Cada pedido abaixo existe para PROVAR uma coisa na tela, no espírito de
 * D-242: nenhum é decoração.
 */
export const E2E_SUPPLIER = { name: "Fornecedor E2E", document: "12345678000199" } as const;

/**
 * Um SEGUNDO fornecedor, e ele é INATIVO de propósito (D20).
 *
 * Com um fornecedor só, `/fornecedores` não tinha como provar nada: o filtro
 * de estado teria sempre o mesmo alvo e a janela declararia sempre "1
 * fornecedor". O inativo é o que faz "Ativos" e "Inativos" recortarem
 * conjuntos diferentes — e é a mesma razão pela qual o seed de `/anuncios`
 * cria um anúncio por estado da faixa (D-242).
 */
export const E2E_SUPPLIER_INATIVO = { name: "Fornecedor E2E Inativo", document: "98765432000188" } as const;

export const E2E_PURCHASE_ORDERS = [
  /**
   * O caso normal: dois itens, ambos com custo. Valor estimado fechado
   * (2 × 100,00 + 5 × 10,50 = 252,50) e nenhuma ressalva.
   */
  {
    chave: "completo",
    status: "APPROVED",
    comFornecedor: true,
    destino: "Depósito Central",
    itens: [
      { sku: "E2E-PC-001", quantidade: 2, custo: 100 },
      { sku: "E2E-PC-002", quantidade: 5, custo: 10.5 },
    ],
  },
  /**
   * **Custo PARCIAL** — a prova de D-254 na lista: um item com custo e outro
   * sem. O valor tem de sair 52,50 **com a ressalva "1 de 2 sem custo"**,
   * nunca 52,50 calado (que leria como total fechado).
   */
  {
    chave: "parcial",
    status: "DRAFT",
    comFornecedor: true,
    destino: null,
    itens: [
      { sku: "E2E-PC-003", quantidade: 5, custo: 10.5 },
      { sku: "E2E-PC-004", quantidade: 3, custo: null },
    ],
  },
  /**
   * **Nenhum item com custo, e SEM fornecedor** — dois "—" numa linha só. O
   * valor estimado tem de ser "—", nunca "R$ 0,00": o rascunho recém-criado,
   * antes de o custo ser negociado, é o estado mais comum da fila. Fornecedor
   * nulo é permitido por desenho ("um rascunho pode nascer antes do
   * fornecedor estar decidido").
   */
  {
    chave: "sem-custo",
    status: "DRAFT",
    comFornecedor: false,
    destino: null,
    itens: [{ sku: "E2E-PC-005", quantidade: 7, custo: null }],
  },
  /**
   * **Pedido sem item nenhum** — aqui o zero é SABIDO, e a tela mostra
   * "R$ 0,00" de propósito. É o par do caso acima: os dois zeros da tela
   * significam coisas diferentes, e o seed carrega os dois para que a
   * diferença seja visível lado a lado.
   */
  { chave: "vazio", status: "CANCELLED", comFornecedor: true, destino: null, itens: [] },
  /**
   * Estado terminal com data de previsão — a quinta linha existe para o filtro
   * de estado ter mais de um alvo e para a coluna Previsão sair do "—".
   */
  {
    chave: "recebido",
    status: "RECEIVED",
    comFornecedor: true,
    destino: "Depósito Central",
    itens: [{ sku: "E2E-PC-006", quantidade: 1, custo: 42 }],
  },
] as const;
