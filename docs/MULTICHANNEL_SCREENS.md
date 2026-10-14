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
| Home | `/` | 2 | — | `get_sales_summary`/`series` (`daily_*`), cobertura, anúncios pausados | faixa de vendas com o marketplace | E4 → T4 |
| Vendas | `/vendas`, `/vendas/shopee` | 2 | `account` (slug, 1 conta ML) · `loja` (uuid) | `daily_*` (ML) · `get_shopee_sales_by_shop`/`get_shopee_orders` | marca, "hoje", ranking e cancelamento consolidados (esperam o grão de SKU, E6) | T1 ✔ (D-431); T4 ✔ (D-440: "Todos" e "Shopee" na mesma tela, várias contas) |
| Faturamento | `/faturamento` | 2 | `account` (slug) · `contas` (uuid, Shopee) | `get_faturamento`, `get_ads_overview` (ML) · `get_shopee_faturamento` (C-58), `get_shopee_ads_*` (C-63) | componentes do recebido, série diária e produtos da Shopee (C-61, T5b) | T5 ✔ (D-442, rascunho #158: "Shopee" e "Todos" lado a lado, sem total); T5c ✔ (D-456: Ads CPC da loja) |
| Central | `/central`, `/central/produtos` | 2 | `account` (slug) | `get_faturamento`, `get_ranking_produtos`, `get_meta_do_mes` | Shopee só depois do Go Live (D-430 §5) | E6/E8 + dono |
| Central Ads e Frete | `/central/ads`, `/central/frete` | 3 | — | Mercado Ads, envios do ML | — | — |
| Metas e limites | `/central/metas`, `/central/limites` | 1 | — | configuração da organização | a meta é medida só com ML (`get_meta_do_mes`) | dono, pós Go Live |
| Produtos | `/produtos` | 2 | — | `get_products_overview` (`daily_sku_metrics`, anúncios ML) | SKU anunciado ou vendido só na Shopee aparece "sem anúncio"/"sem venda" | contrato C-07 + E6 |
| SKU | `/skus/[id]` | 2 | `escopo` (uuid, aba diagnóstico) | `get_sku_dashboard`, `get_sku_sales_breakdown` (ML), `get_sku_shopee_listings`, `get_sku_sales_by_marketplace_account` (C-59) | o dia a dia e os pedidos por canal (só ML) | T6a ✔ (D-444, rascunho #159: entre marketplaces por conta e loja; selo "Teste", C-06) |
| Anúncios | `/anuncios`, `/anuncios/[itemId]`, `/anuncios/shopee` | 3 + tela Shopee própria | `conta` (slug) · `loja` (uuid) | `get_listings_dashboard` · `get_shopee_listings` | na Shopee faltam vendas, exportação e filtros salvos | T1 ✔ (D-431: seletor levando a busca); E6 |
| Vinculações | `/vinculacoes` | 3 | `conta` (slug, chips) | vínculo do ML | o vínculo Shopee mora em `/anuncios/shopee` (tabelas próprias, D-429) | — |
| Estoque | `/estoque`, `/estoque/movimentacoes`, ajuste | 1 | — | ledger | venda Shopee não baixa estoque (fatia 5, adiada) | E8 |
| Full | `/full` | 3 | `conta` (uuid) | snapshot do Full | — | — |
| Reposição, compras | `/reposicao`, `/compras/*` (`/cobertura` redireciona) | 2, bloqueada | — | demanda de `daily_sku_metrics` (ML) | demanda Shopee fora até a fatia 5 — ver risco T-R3 | E8 + dono |
| Curva ABC | `/curva-abc` (+ Excel) | 2 | `conta` (slug) + filtros salvos | `daily_sku_metrics` | marketplace como recorte; filtro "sem Full" só faz sentido com ML | E6 → T6 |
| Preços | `/precos` (+ Excel) | 4 | `conta` (uuid) | eventos de preço do anúncio ML | não há fonte de histórico de preço Shopee | E7 |
| Diagnóstico | `/diagnostico` | 2 (hoje só ML) | — | `daily_sku_metrics`, reclamações ML | — | depois de E6 |
| Central de Ações | `/acoes` | 2 | — | `actions` (`mlb_id`, `account_label`) | nenhum detector gera ação Shopee | futuro |
| Notificações | `/notificacoes`, preferências | 2 | `conta` (uuid) | `domain_events` (ML e, desde D-435, a loja Shopee) | filtro e preferências por loja | T3a ✔ (rótulo e destino, D-438) |
| Atendimento | `/atendimento`, `[caseId]`, `metricas` | 4 | `account` (slug) | `support_*` (`ml_account_id NOT NULL`) | sem chat/devolução Shopee integrados | fora do plano (E7: devoluções) |
| Perguntas | `/atendimento/perguntas` | 3 | `conta` (slug) | perguntas do anúncio ML | — | — |
| Conhecimento, templates | `/atendimento/conhecimento`, `templates` | 1 | — | organização | — | — |
| Sincronização | `/sincronizacao` | 2 | — | `sync_runs`, `daily_account_metrics` (ML) · `marketplace_accounts` (C-52) | frescor do catálogo da loja | T3a ✔ (D-438) |
| Saúde | `/saude` | 1 | — | `job_runs` (já inclui os jobs Shopee) | cadência dos jobs Shopee em `lib/sync-health.ts` | T1 (C-09) |
| Contas | `/contas` | 2 | — | `get_ml_account_cards` + `shopee_shops` | indicadores só do ML; lojas num painel solto | T1 ✔ (D-431: "Contas e lojas" no título e no menu); E3 → T3 |
| Integrações, Configurações | `/integracoes`, `/configuracoes` | 2 | — | cartões fixos; `get_settings_overview` (contagem ML) · `marketplace_accounts` e `shopee_shops` (Shopee) | — | T3b ✔ (D-446: cartão e seção da Shopee) |
| Usuários | `/usuarios` | 2 | — | `user_account_permissions` · `user_shopee_shop_permissions` (D-433) | — | T2 ✔ (D-434) |
| Busca universal | Ctrl+K | 2 | — | `search_entities` | sem loja, anúncio ou pedido Shopee | C-08 → T7 |
| Copiloto | `/copiloto`, gaveta | 2 | — | ferramentas da api, todas ML | Shopee nas ferramentas | futuro |
| Shell e menu | todas | 2 | — | contagem de contas ML conectadas | "N contas conectadas" ignora lojas | E3 → T3 |
| Exportações | anúncios e Full (CSV); ABC, preços, compras (Excel) | conforme a tela | — | — | nenhuma exportação Shopee; `/vendas` não exporta | junto da tela |
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
  anuncia ou vende cai em "sem anúncio"/"sem venda" (C-07).
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
| C-03 | `/faturamento` com marketplace: resumo Shopee (§5), linha por loja na tabela por conta, cobertura por canal | C-58 (D-437) | T5 ✔ (D-442) |
| C-04 | Ranking, curva ABC e aba Vendas do SKU com marketplace | C-59 (D-439), C-60 (curva) | T6a ✔ (D-444); curva na T6b |
| C-05 | Concessão de loja em `/usuarios` | C-54 | E2 → T2 |
| C-06 | Selo de loja de teste no painel Shopee do SKU | `get_sku_shopee_listings` devolvendo o ambiente da loja — **pedido novo** | pequeno |
| C-07 | `/produtos` sem chamar de "sem anúncio"/"sem venda" o SKU que só a Shopee tem | `get_products_overview` contando anúncio e venda Shopee — **pedido novo** | depois de E6 |
| C-08 | Busca universal (Ctrl+K) achando loja, anúncio e pedido Shopee | `search_entities` com a Shopee — **pedido novo** | depois de E3 |
| C-09 | `/saude` com veredito de atraso dos jobs `shopee.*` | nada novo: `job_runs` já os tem; falta a cadência em `apps/web/lib/sync-health.ts` (horários: pedidos e financeiro às :20, catálogo às :25) | T1 |

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
| **T5 ✔** | **código 2026-10-14, D-442.** `/faturamento` com marketplace e a linha por loja; "Todos" lado a lado, sem total; T5b (componentes do recebido e série diária) espera o C-61; **T5c ✔ código 2026-10-14, D-456:** os Ads CPC da loja (C-63) numa seção própria, fora do resultado e sem somar com o Mercado Ads | E5 | componentes não comparáveis nunca somados |
| **T6** | Ranking, curva ABC e aba Vendas do SKU com marketplace; `/produtos` (C-07). **T6a ✔ código 2026-10-14, D-444:** ranking no "Todos"/"Shopee" e a aba Vendas do SKU (C-59); T6b curva ABC (C-60); T6c `/produtos` (C-56) | E6 | — |
| **T7** | Busca universal com a Shopee (C-08) | C-08 | — |
| **T8** | Central e meta do mês com a Shopee | Go Live + dono | — |

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
| T-R3 | A planilha do UpSeller já desconta a venda Shopee do estoque, mas a demanda da reposição só conta o ML | cobertura alta demais e sugestão de compra baixa demais para SKU que vende na Shopee — **inferência**, a medir com dado real | registrado para o dono e o A1 (fatia 5) |
| T-R4 | `/vendas/shopee` e `/anuncios/shopee` ficam fora do menu | quem não passa pelo link do subtítulo não acha | **resolvido na T1** (D-431): a troca é o primeiro menu do cabeçalho das telas de vendas e de anúncios |
| T-R5 | No celular, o cartão "Por loja" de `/vendas/shopee` sobrepõe as notas pequenas ("1 sem receita conhecida", "3 aguardando o financeiro") ao valor ao lado — **preexistente** (D-430), visto nas fotos da T1 | leitura difícil na largura de 390 px | **corrigido em 14/10**: só na tabela "Por loja" (`.sb-vendas-lojas`), a célula do cartão quebra e a nota desce; o e2e `vendas-shopee` mede que nenhuma nota passa da própria célula |
