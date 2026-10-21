# Telas multicanais — auditoria, filtro Marketplace/Conta e lacunas

> Dono: Agente 2 (telas, filtros, dashboards). Complementa `docs/MULTICHANNEL_CONTRACTS.md`
> (Agente 1: identidade, contratos de dados, **o que soma entre canais (§5)**,
> riscos e o plano E0–E8) — este documento não repete aquilo, aponta. Estado
> corrente e bloqueios: `docs/MULTICHANNEL_HANDOFF.md`. Fonte de verdade: o
> código da `main` em `562b1e60` (14/10/2026), lido rota a rota.

---

## 1. Princípios da experiência

1. **Uma tela, três níveis.** Consolidado (todos os marketplaces e contas que a
   pessoa alcança), por marketplace e por conta (uma ou várias) são a MESMA
   tela com outro recorte — como "Geral" e "por Conta" já são a mesma `/vendas`
   (D-033). Não nasce tela nova por canal quando a estrutura é a mesma.
2. **O padrão continua só Mercado Livre** até o "Todos" existir no SQL (D-430
   §1; ROADMAP, fatia 6b). Abrir `/vendas` sem parâmetro mostra o que mostra hoje.
3. **Agregação no SQL, nunca na tela.** O consolidado vem de uma RPC que já
   devolve a linha de total; a web não soma as linhas por canal. Só soma o que
   é comparável (`docs/MULTICHANNEL_CONTRACTS.md` §5): unidades, receita bruta, compras
   (pack do ML + pedido da Shopee), cancelados, ticket recalculado. "Pedidos do
   Mercado Livre" e "recebido" ficam por canal, cada um com a sua definição.
4. **Loja de teste (sandbox) nunca entra em total.** Aparece só no recorte
   Shopee, com o selo "Teste".
5. **Específico continua específico.** Full, Mercado Ads, detector de frete,
   Perguntas, relist, campanhas e a Central de Vinculações são do Mercado
   Livre e não ganham "versão Shopee" de fachada; num recorte sem ML, a seção
   some com uma frase dizendo por quê.
6. **Filtro visual não é segurança.** O seletor só lista o que a RLS entrega;
   a regra de quem vê qual loja é do SQL (risco S1, etapa E2).
7. **Ausente não é zero.** Métrica que a Shopee ainda não tem mostra "—" com o
   motivo; o histórico Shopee de 90 dias (o ML tem 365) é declarado em toda
   comparação que passe disso.

---

## 2. Inventário das telas

Classes: **1** compartilhada · **2** compartilhada com adaptação · **3**
específica do ML · **4** ainda sem suporte para a Shopee · **5** não se aplica.
"Etapa" é a do plano de `docs/MULTICHANNEL_CONTRACTS.md` §7 (dados) ou T* (web, §8 aqui).

| Área | Rotas | Classe | Conta hoje (URL) | Fonte | O que falta para o multicanal | Etapa |
|---|---|---|---|---|---|---|
| Home | `/` | 2 | — | `get_marketplace_sales_summary`/`_daily` (C-53, ML + Shopee), cobertura, anúncios pausados | T10 ✔ (D-488): a faixa e o gráfico de todos os marketplaces, decisão do dono de 16/10 | C-53 |
| Vendas | `/vendas`, `/vendas/shopee` | 2 | `account` (slug, 1 conta ML) · `loja` (uuid) | `daily_*` (ML) · `get_shopee_sales_by_shop`/`get_shopee_orders` | marca, "hoje" e cancelamento no "Todos" (pedem contrato do A1: o C-53 não traz cancelamento nem marca; o ranking entre marketplaces está na T6a, D-444) | T1 ✔ (D-431); T4 ✔ (D-440: "Todos" e "Shopee" na mesma tela, várias contas); T10 ✔ (D-488: sem `marketplace` abre em "Todos", o ML é `marketplace=ml`) |
| Faturamento | `/faturamento` | 2 | `account` (slug) · `contas` (uuid, Shopee) | `get_faturamento`, `get_ads_overview` (ML) · `get_shopee_faturamento` (C-58), `get_shopee_faturamento_*` (C-61), `get_shopee_ads_*` (C-63), `get_shopee_repasse*` (C-64) | — | T5 ✔ (D-442: "Shopee" e "Todos" lado a lado, sem total); T5b ✔ (D-452: a cascata, a série e os produtos); T5c ✔ (D-456: Ads CPC da loja); T5d ✔ (D-458: repasse); D-492 ✔ (a proteção de envio como degrau da cascata, sobre a D-483); D-498 ✔ (os ajustes depois do repasse e o lucro após imposto e Ads, sobre a D-485 e a D-487) |
| Central | `/central`, `/central/produtos` | 2 | `account` (slug) | `get_faturamento`, `get_ranking_produtos`, `get_meta_do_mes` | T8a ✔ (D-480): a Shopee lado a lado, sem total de resultado (o bloco do "Todos" de `/faturamento`) | E6/E8 + dono |
| Central Ads e Frete | `/central/ads`, `/central/frete` | 3 | — | Mercado Ads, envios do ML | — | — |
| Metas e limites | `/central/metas`, `/central/limites` | 1 | — | configuração da organização | T8b ✔ (D-482): a meta de cada marketplace ao lado da geral, decisão do dono de 15/10 | C-66 (D-473) |
| Produtos | `/produtos` | 2 | — | `get_products_overview` (`daily_sku_metrics`, anúncios ML) | — (o SKU só da Shopee deixou de aparecer "sem anúncio"/"sem venda" na T6c, D-454) | C-56 (D-445) → **T6c ✔ (D-454)** |
| SKU | `/skus/[id]` | 2 | `escopo` (uuid, aba diagnóstico) | `get_sku_dashboard`, `get_sku_sales_breakdown` (ML), `get_sku_shopee_listings`, `get_sku_sales_by_marketplace_account` (C-59) | o dia a dia e os pedidos por canal: a D-618, sobre o C-71 do A1 (o C-10, §7), no ar desde 20/10 (#284) | T6a ✔ (D-444, rascunho #159: entre marketplaces por conta e loja; selo "Teste", C-06) |
| Anúncios | `/anuncios`, `/anuncios/[itemId]`, `/anuncios/shopee` | 3 + tela Shopee própria | `conta` (slug) · `loja` (uuid) | `get_listings_dashboard` · `get_shopee_listings` | — (as vendas por anúncio da Shopee desde a D-606, sobre o C-67 da D-493) | T1 ✔ (D-431: seletor levando a busca); T11 ✔ (D-490: o CSV dos anúncios da Shopee); D-494 ✔ (filtros salvos); E6 |
| Vinculações | `/vinculacoes` | 3 | `conta` (slug, chips) | vínculo do ML | o vínculo Shopee mora em `/anuncios/shopee` (tabelas próprias, D-429) | — |
| Estoque | `/estoque`, `/estoque/movimentacoes`, ajuste | 1 | — | ledger | venda Shopee não baixa estoque: a D-495 do A1 está em desenho (decisão do dono de 19/10), e a tela (rótulos, origem "Pedido Shopee" e nota da `/estoque`) é do A2 | E8 |
| Full | `/full` | 3 | `conta` (uuid) | snapshot do Full | — | — |
| Reposição, compras | `/reposicao`, `/compras/*` (`/cobertura` redireciona) | 2, bloqueada | — | demanda de `daily_sku_metrics` (ML) + Shopee (C-65) | T-R3 ✔ (D-464): a demanda da Shopee dita pela própria RPC, o selo em "Dados usados" e a parte da Shopee na venda; T-R3b ✔ (D-466): a parte da Shopee na gaveta e na cobertura do SKU | E8 + dono |
| Curva ABC | `/curva-abc` (+ Excel) | 2 | `conta` (slug, ML) · `marketplace` + `contas` (uuid) + filtros salvos | `get_sku_abc_*` com `p_marketplaces`/`p_account_ids` (C-60) | — | T6b ✔ (D-448: "Todos" e "Shopee", compras como critério); T6b2 ✔ (D-450: o Excel com o recorte) |
| Preços | `/precos` (+ Excel) | 4 | `conta` (uuid) | eventos de preço do anúncio ML | não há fonte de histórico de preço Shopee | E7 |
| Diagnóstico | `/diagnostico` | 2 (hoje só ML) | — | `daily_sku_metrics`, reclamações ML | — | depois de E6 |
| Central de Ações | `/acoes` | 2 | — | `actions` (`mlb_id`, `account_label`) | nenhum detector gera ação Shopee | futuro |
| Notificações | `/notificacoes`, preferências | 2 | `conta` (uuid) | `domain_events` (ML e, desde D-435, a loja Shopee) | a escrita em lote por loja (C-69, D-491: `p_shopee_shop_id` em `mark_notifications_read`, em produção desde 20/10; a tela é a D-616) e as preferências por loja (`notification_preferences` só conhece a conta do ML) | T3a ✔ (rótulo e destino, D-438); D-604 ✔ (o recorte por loja) |
| Atendimento | `/atendimento`, `[caseId]`, `metricas` | 4 | `account` (slug) | `support_*` (`ml_account_id NOT NULL`) | sem chat Shopee integrado; as devoluções da Shopee ficam em `/vendas/shopee` (D-460) | fora do plano |
| Perguntas | `/atendimento/perguntas` | 3 | `conta` (slug) | perguntas do anúncio ML | — | — |
| Conhecimento, templates | `/atendimento/conhecimento`, `templates` | 1 | — | organização | — | — |
| Sincronização | `/sincronizacao` | 2 | — | `sync_runs`, `daily_account_metrics` (ML) · `marketplace_accounts` (C-52) e `shopee_shops` | — (o catálogo da loja no cartão dela desde a D-608, com o caminho para os anúncios) | T3a ✔ (D-438); T3c ✔ (D-462: devoluções, repasses e Ads lidos até quando) |
| Saúde | `/saude` | 1 | — | `job_runs` (já inclui os jobs Shopee) | — (a cadência dos jobs Shopee desde a T1, C-09, e os jobs novos no #170) | T1 (C-09) |
| Contas | `/contas` | 2 | — | `get_ml_account_cards` + `shopee_shops` | — (a faixa conta contas e lojas desde a D-600; as lojas seguem na tabela própria, com o catálogo e a autorização) | T1 ✔ (D-431: "Contas e lojas" no título e no menu); D-600 ✔ (a faixa com os dois canais) |
| Integrações, Configurações | `/integracoes`, `/configuracoes` | 2 | — | cartões fixos; `get_settings_overview` (contagem ML) · `marketplace_accounts` e `shopee_shops` (Shopee) | — | T3b ✔ (D-446: cartão e seção da Shopee); T3c ✔ (D-462: o cartão julga os sete jobs) |
| Usuários | `/usuarios` | 2 | — | `user_account_permissions` · `user_shopee_shop_permissions` (D-433) | — | T2 ✔ (D-434) |
| Busca universal | Ctrl+K | 2 | — | `search_entities` | T7 ✔ (D-476): loja, anúncio e pedido da Shopee, com "Outros" para tipo desconhecido; o pedido abre filtrado em `/vendas/shopee` | C-08/C-57 → T7 |
| Copiloto | `/copiloto`, gaveta | 2 | — | ferramentas da api, todas ML | Shopee nas ferramentas | futuro |
| Shell e menu | todas | 2 | — | `marketplace_accounts` conectadas (contas do ML e lojas Shopee) | — (o "N contas conectadas" conta as lojas desde a D-438; a lacuna antiga estava desatualizada, D-490 §5) | ✔ D-438 |
| Exportações | anúncios e Full (CSV); ABC, preços, compras (Excel) | conforme a tela | — | — | — (o recorte do Mercado Livre exporta a série por dia pela leitura da própria tela desde a D-602) | T11 ✔ (D-490): pedidos e anúncios da Shopee em CSV, com o recorte da tela; D-496 ✔: `/vendas` no "Todos" e na Shopee, por dia e por conta |
| Sugestões, fornecedores, NF-e, importações, login | — | 1 / 5 | — | organização / ERP | — | — |

---

## 3. Filtros de conta hoje — o que a auditoria achou

- **Cinco convenções para a mesma ideia.** `account` (slug) em `/vendas`,
  `/faturamento`, `/central` e `/atendimento`; `conta` (slug) em `/anuncios`,
  `/vinculacoes`, `/curva-abc` e Perguntas; `conta` (**uuid**) em `/full`,
  `/precos` e `/notificacoes`; `escopo` (uuid) no diagnóstico do SKU; `loja`
  (uuid) nas telas Shopee.
- **Nenhum carregador comum.** Cerca de 20 telas repetem
  `from("ml_accounts").select("id, slug, label")`; três repetem o de
  `shopee_shops`. A RLS decide o que cada um vê.
- **Uma conta por vez.** Toda RPC do ML recebe um `p_ml_account_id uuid`;
  nenhuma aceita várias contas, canal ou marketplace.
- **Filtros salvos** só em `/vendas`, `/anuncios` e `/curva-abc`, e guardam os
  parâmetros como `Record<string, string>`: um parâmetro repetido na URL se
  perde ao salvar — seleção múltipla tem de caber num valor só.
- **`canal` já tem dono.** Em `/atendimento` o parâmetro `canal` é o tipo de
  caso (QUESTION, POST_SALE_MESSAGE, CLAIM); `support_cases.channel` e
  `sync_runs.channel` também existem. O filtro de marketplace usa outro nome.

---

## 4. O filtro Marketplace/Conta (desenho da web)

**URL.** `marketplace` = `ml` | `shopee` | `todos`; ausente = o padrão (`ml`
até E4). `contas` = ids da fonte única de contas (C-52, `marketplace_accounts`, etapa E3),
separados por vírgula, para caber num filtro salvo. O `account`/`conta` antigo
(slug do ML) continua aceito na LEITURA, convertido para o id — links e filtros
salvos de hoje não quebram.

**Regras de compatibilidade** (função pura, testada):

1. Uma conta só fica no recorte se pertence a um marketplace do recorte.
2. Trocar de marketplace tira as contas incompatíveis e mantém período, marca,
   métrica e o resto.
3. Voltar para "todos" mantém as contas escolhidas (todas são compatíveis).
4. Conta desconhecida ou fora do alcance da pessoa sai do recorte **com aviso**
   ("1 conta do link não está disponível para você") — hoje o slug desconhecido
   cai calado em "todas as contas".
5. Loja de teste só é opção no recorte Shopee, com "(teste)", e nunca entra em
   "todos".
6. Marketplace sem nenhuma conta visível não aparece como opção; com um só
   marketplace visível, o seletor de marketplace nem aparece.

**Fonte das opções.** As contas reais (E3); até lá, `ml_accounts` e
`shopee_shops` como as telas já leem. O nome exibido de cada marketplace é um
rótulo por código (`ML` → "Mercado Livre"), como `lib/labels.ts` faz com os
demais enums — a LISTA vem das contas, não de uma constante.

**Componente.** Server Component sobre o `FilterMenu`: cada opção é link e o
estado mora na URL (compartilhável, voltar do navegador e filtros salvos
funcionando). A escolha de várias contas é um `<form method="get">` com
caixas de seleção dentro do painel — o mesmo recurso do período personalizado
de `/vendas`, sem estado React.

**Por tela, a seção específica obedece ao recorte:** Mercado Ads, Full e
taxa de comissão do ML só aparecem com o ML no recorte; o pedido de venda do
ML ("Pedidos do Mercado Livre") só no recorte ML.

---

## 5. Vendas e Faturamento — o detalhe

### Vendas

**`/vendas` hoje (ML).** Filtros: conta (uma), marca (com "sem marca"),
período (7/15/30/60/90 e personalizado), métrica do gráfico, filtros salvos e
o selo de frescor do recálculo. Faixa: receita bruta, pedidos, unidades,
ticket médio, taxa de cancelamento, cada um contra o período anterior. "Hoje"
ao vivo. Gráfico diário com o período anterior. Ranking dos 10 SKUs. Atalho
para `/faturamento` e link para `/vendas/shopee`. **Não exporta.**

**`/vendas/shopee` hoje.** Loja (uma), período (presets; o personalizado só
pela URL — falta o formulário), situação, paginação. Tabela por loja (sem
total, de propósito) e a lista de pedidos com o SKU gravado. **Não tem**:
faixa de indicadores, comparação, gráfico, ranking, marca, filtros salvos.

**Lacunas para a tela única (T4, depende de E3 e E4):**

| Bloco | ML | Shopee | Consolidado |
|---|---|---|---|
| Receita bruta, unidades | existe | `get_shopee_sales_by_shop` por loja | soma no SQL (E4) |
| Pedidos | "Pedidos do ML" = linha | pedido = carrinho | **não soma**; o consolidado mostra **compras** |
| Ticket médio | receita ÷ compras | receita ÷ pedidos | recalculado no SQL |
| Cancelamento | taxa (5C) | contagem por loja | precisa de definição comum (E4) |
| Comparação com o anterior | existe | não existe | E4, com a cobertura de 90 dias declarada |
| Série diária | `daily_*` | não existe | E4 (série por canal) |
| Ranking de SKU | `daily_sku_metrics` | não existe | E6 |
| "Hoje" | ao vivo (webhook) | leitura de hora em hora | por canal, com a hora da leitura |
| Frescor | passada do recálculo | `orders_synced_until` por loja | o pior dos dois, dito por canal |
| Marca | existe | possível pelo `sku_id` do item | E4 |

A lista de pedidos da Shopee continua como detalhe do recorte Shopee (o ML
não tem lista de pedidos em `/vendas`).

### Faturamento

**`/faturamento` hoje (ML).** Conta e período; faixa (receita, resultado,
margem, comissão do ML, ticket) contra o anterior; cascata; custos da venda;
receita e margem por dia; tabela por conta; produtos (maior receita, menor
margem); cobertura; Mercado Ads; calculadora de preço (que **já** tem a
Shopee, por faixa — D-359).

| Componente | ML (`get_faturamento`) | Shopee (dado em `shopee_orders`, D-427) | Na tela |
|---|---|---|---|
| Faturamento bruto | sim | sim (5S) | por canal + total comparável |
| Comissão e tarifas | comissão (sem taxa fixa e parcelamento) | comissão, taxa de serviço e de transação (líquidas do Brasil) | por canal, nunca somadas sob um rótulo só |
| Frete do vendedor | desde 14/09/2026 | frete final (pode ser negativo) | por canal |
| Descontos | do vendedor, informativo | por quem bancou (loja/Shopee) | por canal |
| Reembolsos e ajustes | fora | só dentro do `order_income`, semântica não conferida (R9) | "—" com o motivo |
| Cancelamentos | em `/vendas` | contagem | contagem de compras canceladas |
| Publicidade | Mercado Ads | não integrada | só no recorte com ML |
| Resultado e margem | sobre pedidos cobertos | escrow − custo, definitivo e provisório (5U, C-58) | por canal, lado a lado e sem total (D-442); nunca "lucro líquido" |
| Cobertura | frete, custo e item único | financeiro lido, custo conhecido | por canal |

---

## 6. Produtos, SKU e anúncios

- **SKU canônico** é o único ponto comum (`skus.id`). A página do SKU já mostra
  os anúncios Shopee vinculados (D-429: loja, item, variação, SKU do anúncio,
  preço, estoque do anúncio, status, origem do vínculo). Faltam: o selo de loja
  de teste (a RPC não devolve o ambiente — C-06) e **vendas por canal** — a aba
  Vendas e a visão geral leem só `daily_sku_metrics` (E6).
- **`/produtos`** conta anúncio e venda só do ML: um SKU que só a Shopee
  anuncia ou vende cai em "sem anúncio"/"sem venda" (C-07). **Resolvido na
  T6c (D-454):** com loja live, os filtros dizem em que marketplace, os cartões
  dizem "em nenhum marketplace" e a coluna de giro mostra cada um, sem total.
- **Anúncios** ficam em duas listas, com razão: o anúncio ML e o Shopee têm
  estados, campos e ações diferentes (Full, promoção, relist só no ML). A
  experiência única vem da troca de marketplace na mesma posição do cabeçalho
  (T1) e, com E6, do desempenho do anúncio Shopee no período.
- **Vínculo**: cada canal mantém a sua ação (Central de Vinculações para o ML,
  popup em `/anuncios/shopee` para a Shopee); as regras são do banco (D-428,
  D-429) e a web não as altera.

---

## 7. Contratos que a web precisa

Ids do handoff: **C-01…** são os de CONSUMO (a tela, Agente 2); **C-50…** os de
DADOS (Agente 1, `docs/MULTICHANNEL_CONTRACTS.md`). A tabela de estado de todos
fica em `docs/MULTICHANNEL_HANDOFF.md`. Critério de aceite comum: **com só ML,
o número é o mesmo da RPC atual** (teste de equivalência), e a web nunca soma
linhas.

| Id | A tela | Consome | Etapa |
|---|---|---|---|
| C-01 | Seletor Marketplace/Conta (§4) em toda tela que filtra por conta; `/contas`, `/sincronizacao` e o shell com as lojas | C-52 `marketplace_accounts` (com o slug do ML para os links antigos; permissão por conta e por loja) | E3 (+E2) → T3 |
| C-02 | `/vendas` e a faixa de vendas da Home com "todos", "ml" e "shopee", várias contas, marca e frescor por canal | C-53 `get_marketplace_sales_summary` + série diária | E4 → T4 |
| C-03 | `/faturamento` com marketplace: resumo Shopee (§5), linha por loja na tabela por conta, cobertura por canal | C-58 (D-437), C-61 (D-443), C-63 (D-449), C-64 (D-451) | T5 ✔ (D-442); T5b ✔ (D-452); T5c ✔ (D-456); T5d ✔ (D-458) |
| C-04 | Ranking, curva ABC e aba Vendas do SKU com marketplace | C-59 (D-439), C-60 (curva) | T6a ✔ (D-444); T6b ✔ (D-448); Excel na T6b2 ✔ (D-450) |
| C-05 | Concessão de loja em `/usuarios` | C-54 | E2 → T2 |
| C-06 | Selo de loja de teste no painel Shopee do SKU | `get_sku_shopee_listings` devolvendo o ambiente da loja — **pedido novo** | pequeno |
| C-07 | `/produtos` sem chamar de "sem anúncio"/"sem venda" o SKU que só a Shopee tem | `get_products_overview` contando anúncio e venda Shopee — **pedido novo** | C-56 (D-445) → T6c ✔ (D-454) |
| C-08 | Busca universal (Ctrl+K) achando loja, anúncio e pedido Shopee | `search_entities` com a Shopee — **pedido novo** | depois de E3 |
| C-09 | `/saude` com veredito de atraso dos jobs `shopee.*` | nada novo: `job_runs` já os tem; falta a cadência em `apps/web/lib/sync-health.ts` (horários: pedidos e financeiro às :20, catálogo às :25) | T1 |
| C-10 | Aba Vendas do SKU: o dia a dia por canal e os pedidos da Shopee com o SKU (escolha do dono em 20/10) | o dia a dia do SKU por marketplace e `get_shopee_orders` com `p_sku_id` (abaixo); o contrato de dados é o C-71 do A1 (D-607) | D-618 depois do contrato |

### C-10 — o SKU com a Shopee: os pedidos e o dia a dia por canal (pedido ao A1 em 20/10)

Escolha do dono em 20/10 (item 4 (b) das decisões pendentes, no handoff
multicanal). A tela é a aba Vendas de `/skus/[id]`, só com loja Shopee
visível (como a seção "entre marketplaces" da D-444), no período da aba: 30
dias em datas de São Paulo. Hoje, com loja, a aba mostra o total e uma linha
por conta e por loja (C-59); o dia a dia e os detalhes são só do ML.

**1. O dia a dia por canal.** Uma linha por dia com venda em algum canal:
- `dia` (data de negócio);
- `unidades_ml`, `receita_ml`;
- `unidades_shopee`, `receita_shopee`, `itens_shopee_sem_receita`;
- `unidades` e `receita_bruta`, o total do dia somado no SQL.

Regras:
- o grão e as regras do C-59: o ML por `daily_sku_metrics`, a Shopee por
  `shopee_sales_items` com `situacao = 'VALIDA'`, a loja de teste fora das
  somas, e a receita da Shopee só com os itens de receita conhecida (os outros
  contados em `itens_shopee_sem_receita`);
- canal sem venda no dia é NULO, não zero; dia sem venda em canal nenhum não
  aparece (D-067);
- função nova ou nível novo, a critério do A1, mas a chamada de hoje do C-59
  devolve as mesmas linhas: a tela em produção lê só `TOTAL` e `CONTA`.

Aceite: a soma dos dias de cada canal igual à soma das linhas `CONTA` desse
canal no C-59 (sem a loja de teste); o ML de cada dia igual à linha por dia do
`get_sku_sales_breakdown`.

**2. Os pedidos da Shopee com o SKU.** O `get_shopee_orders` ganha no fim
`p_sku_id uuid default null`; nulo é a lista de hoje. Com valor:
- só os pedidos com algum item desse SKU (o `sku_id` do item, o da view);
- três colunas no fim, somadas no SQL só sobre os itens do SKU e nulas sem
  `p_sku_id`: `dia` (a data de negócio do pedido, para o link),
  `unidades_do_sku` e `receita_do_sku` (nula se algum item do SKU no pedido
  tem receita desconhecida);
- o resto como hoje: todas as situações, a loja de teste com `environment`,
  a permissão por loja e as páginas de até 200 com `total_count`.

Aceite: a soma de `unidades_do_sku` dos pedidos `VALIDA` do período igual às
unidades da Shopee do C-59 para o SKU (sem a loja de teste).

**Na tela (D-618, depois da migration em produção):**
- "Por dia, por canal" na seção entre marketplaces. O "Por dia" do ML
  continua em "No Mercado Livre", porque pedidos e compras são do ML.
- "Pedidos da Shopee com este SKU": pedido, loja, dia, situação, unidades e
  receita do SKU, com o "Abrir pedido" para
  `/vendas/shopee?loja=<loja>&from=<dia>&to=<dia>&pedido=<order_sn>` (o link
  da D-614), em páginas.
- `p_sku_id` vai só com valor e só depois da migration (PGRST202 antes).

**Para o A1 medir:** o custo como `authenticated`, em 30 dias e no SKU que
mais vende, e se `shopee_order_items` pede índice por `sku_id`.

**O kit (resposta do A1, 20/10):** o grão é o `sku_id` gravado no item, como
no C-59 e no `daily_sku_metrics` do ML. A página do kit mostra as vendas do
kit; a de um componente não mostra as vendas dos kits que o contêm, em
canal nenhum. É o que a aba já mostra hoje; os componentes seriam outro
contrato.

---

## 8. Sequência da web

Cada etapa: testes unitários do que é puro, e2e da tela, `pnpm run check`,
`pnpm run build`, `pnpm docs:check`, e as telas do ML conferidas sem mudança de
número.

| Etapa | O quê | Depende | Aceite |
|---|---|---|---|
| **T0** | Esta auditoria | — | documento na `main` |
| **T1 ✔** | Modelo e seletor de marketplace (`lib` pura + componente) nas duas telas que já têm os dois canais: `/vendas` ↔ `/vendas/shopee` e `/anuncios` ↔ `/anuncios/shopee`, levando o período; formulário de período personalizado em `/vendas/shopee`; `/contas` com título e texto que falam dos dois canais; cadência dos jobs `shopee.*` em `/saude` (C-09) | nada (só leitura que já existe) | **código 2026-10-14, D-431** — ver a nota abaixo da tabela |
| **T2 ✔** | Concessão de loja em `/usuarios`: gaveta, coluna, histórico e convite | E2 (C-54) | **código 2026-10-14, D-434** — o ADMIN concede e retira, e o efeito chega à tela de quem recebe (e2e) |
| **T3a ✔ / T3b ✔** | **T3b, código 2026-10-14, D-446:** o cartão da Shopee em `/integracoes` e a seção em `/configuracoes`; o seletor fica nas tabelas-base (a view só valeria o custo onde se lê o frescor). **T3a, código 2026-10-14, D-438:** o aviso da loja (D-435) com nome e destino, as lojas em `/sincronizacao` com os limiares do vigia e a contagem do shell por `marketplace_accounts`. **T3b:** seletor lendo C-52; lojas em `/sincronizacao`, `/saude`, `/integracoes`, `/configuracoes` e na contagem do shell | E3 | uma fonte de contas em todas as telas que filtram por conta |
| **T4 ✔** | **código 2026-10-14, D-440.** `/vendas` com "todos", "ml" e "shopee" na mesma estrutura, várias contas, comparação e gráfico; `/vendas/shopee` vira o detalhe de pedidos do recorte Shopee; faixa de vendas da Home | E4 | ML idêntico ao de hoje; "todos" = linha de total do SQL; sandbox fora |
| **T5 ✔** | **código 2026-10-14, D-442.** `/faturamento` com marketplace e a linha por loja; "Todos" lado a lado, sem total; **T5b ✔ código 2026-10-14, D-452:** a cascata do recebido, a série diária e os produtos (C-61); **T5c ✔ código 2026-10-14, D-456:** os Ads CPC da loja (C-63) numa seção própria, fora do resultado e sem somar com o Mercado Ads; **T5d ✔ código 2026-10-14, D-458:** o repasse ao lado do previsto, pelo dia da liberação (C-64) | E5 | componentes não comparáveis nunca somados |
| **T6** | Ranking, curva ABC e aba Vendas do SKU com marketplace; `/produtos` (C-07). **T6a ✔ código 2026-10-14, D-444:** ranking no "Todos"/"Shopee" e a aba Vendas do SKU (C-59); **T6b ✔ código 2026-10-14, D-448:** curva ABC com "Todos" e "Shopee" (C-60), e **T6b2 ✔ D-450** o Excel com o recorte; **T6c ✔ código 2026-10-14, D-454:** `/produtos` com a Shopee (C-56) | E6 | — |
| **Devoluções ✔** | **código 2026-10-15, D-460.** As devoluções da Shopee em `/vendas/shopee`, logo depois do "Por loja" (C-62), decisão do dono de 15/10 | E7a | situação como a Shopee manda; "valor de reembolso informado", nunca "reembolsado" |
| **T7** | Busca universal com a Shopee (C-08) | C-08/C-57 | ✔ D-476 |
| **T8** | Central e meta do mês com a Shopee | dono (15/10) + C-66 | T8a ✔ D-480; T8b ✔ D-482 |
| **T9** | Ensaio do Go Live das telas: uma loja live no e2e, no projeto `loja-live` | Go Live (16/10) | ✔ D-486 |
| **T10** | A Home e a `/vendas` em todos os marketplaces por padrão | dono (16/10) | ✔ D-488 |
| **T11** | Os pedidos e os anúncios da Shopee em CSV | — | ✔ D-490 |
| **D-492** | A proteção de envio da Shopee como degrau da cascata do faturamento | A1 (D-483) | ✔ D-492 |
| **D-494** | Filtros salvos em `/anuncios/shopee` e `/vendas/shopee` | — | ✔ D-494 |
| **D-496** | O CSV de `/vendas` no "Todos" e na Shopee, e a série diária em páginas | — | ✔ D-496 |
| **D-498** | Os ajustes depois do repasse e o lucro após imposto e Ads da Shopee | A1 (D-485, D-487) | ✔ D-498 |
| **D-600** | A faixa de `/contas` com as contas do ML e as lojas Shopee | — | ✔ D-600 |
| **D-602** | O CSV de `/vendas` no recorte do Mercado Livre, e a série do ML em páginas | — | ✔ D-602 |
| **D-604** | As notificações recortadas por loja Shopee | — (o lote por loja espera o A1) | ✔ D-604 |
| **D-606** | As vendas por anúncio na `/anuncios/shopee`: período, vendeu, ordem e recorte | A1 (D-493, C-67) | ✔ D-606 (#251) |
| **D-608** | O catálogo da loja Shopee na `/sincronizacao` | — | ✔ D-608 |
| **D-610** | A `/central` sem a leitura do faturamento em dobro | A1 (o achado), A3 (a Central) | ✔ D-610 |
| **D-612** | A nota de venda do marketplace como "Não aplicada" em `/notas-fiscais` | A1 (D-497 b) | ✔ D-612 (#262) |
| **D-614** | A venda da Shopee nas movimentações de estoque | A1 (D-495 b, C-68) | ✔ D-614 (#268) |
| **D-616** | Marcar em lote por loja Shopee | A1 (D-491, C-69) | ✔ D-616 (#272) |
| **D-618** | O dia a dia por canal e os pedidos da Shopee na aba Vendas do SKU | A1 (C-71, D-607) | ✔ D-618 (#284) |
| **D-620** | O cancelamento por compra e o hoje ao vivo no "Todos" e na Shopee de `/vendas` | A1 (C-70, D-603) | ✔ D-620 (#284) |
| **D-622** | A marca no "Todos" e na Shopee de `/vendas` | A1 (C-72, D-605) | em código |

**T1 em código (D-431, 14/10).** O seletor (`components/seletor-marketplace.tsx`,
regras em `lib/marketplace.ts`) é o primeiro menu das quatro telas e só aparece
com conta ML **e** loja Shopee visíveis — contadas no banco (`count`, `head`).
Atravessa só o que vale nos dois lados: o período nas vendas; a busca nos
anúncios, menos o código MLB. Nesta etapa ele escolhe entre as telas que já
existem; a URL ainda não leva `marketplace` (isso nasce com o "todos", T4).
Validado: `check`, `build` e `docs:check` verdes; 13 unitários novos; e2e 41/41
nas telas tocadas e a suíte inteira 208/208 (4 só passaram reexecutadas, por
ambiente — ver D-431); fotos no desktop e no celular, que pegaram o painel do
primeiro menu cortado atrás da lateral (corrigido com `alinhamento="inicio"`).

---

## 9. Riscos de tela

| # | O quê | Efeito | Tratamento |
|---|---|---|---|
| T-R1 | Usuário restrito a uma conta ML vê todas as lojas Shopee (S1) | qualquer seletor de loja expõe o que a pessoa não deveria ver | E2 antes de T3; até lá, nenhuma tela nova lista lojas além das que já listam |
| T-R2 | Comparar período com mais de 90 dias | a Shopee parece ter crescido do nada | declarar a cobertura do histórico na comparação (T4) |
| T-R3 | A planilha do UpSeller já desconta a venda Shopee do estoque, mas a demanda da reposição só conta o ML | cobertura alta demais e sugestão de compra baixa demais para SKU que vende na Shopee — **inferência**, a medir com dado real | o dono liberou em 15/10; C-65 do A1 (D-459) e a tela (D-464) |
| T-R4 | `/vendas/shopee` e `/anuncios/shopee` ficam fora do menu | quem não passa pelo link do subtítulo não acha | **resolvido na T1** (D-431): a troca é o primeiro menu do cabeçalho das telas de vendas e de anúncios |
| T-R5 | No celular, o cartão "Por loja" de `/vendas/shopee` sobrepõe as notas pequenas ("1 sem receita conhecida", "3 aguardando o financeiro") ao valor ao lado — **preexistente** (D-430), visto nas fotos da T1 | leitura difícil na largura de 390 px | **corrigido em 14/10**: só na tabela "Por loja" (`.sb-vendas-lojas`), a célula do cartão quebra e a nota desce; o e2e `vendas-shopee` mede que nenhuma nota passa da própria célula |
