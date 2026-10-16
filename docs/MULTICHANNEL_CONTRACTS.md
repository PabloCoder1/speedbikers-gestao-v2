# Camada de dados multicanal — auditoria, contratos e plano

> Dono: Agente 1 (integração, backend e dados). Leitor principal: Agente 2
> (telas, filtros, dashboards). Fonte de verdade: o código da `main` em
> `562b1e60` (14/10/2026) e o que foi medido em produção no mesmo dia. O
> contrato da API da Shopee está em `docs/SHOPEE.md`; as definições de
> métrica, em `docs/METRICS.md`. **Nada aqui promete o que não existe:** cada
> contrato diz onde ele está (código, Dev, produção).

---

## 1. Estado medido em 14/10/2026

| Camada | Código (`main`) | Dev | Produção |
|---|---|---|---|
| Migrations Shopee e multicanal | `20261013120000` → `20261014200000` (D-425 a D-435); `20261014210000` (D-436) em PR | todas da `main` | até `20261014200000` (D-435, run `38585020320`, 14/10) |
| Worker / api | D-435 | pausado (D-350) | `worker-00045-c2f` e `api-00028-qmw` em `93304ac3` (14/10); sandbox, `SHOPEE_PARTNER_ID=1248019` |
| Web | D-430 | — | `562b1e60` (D-430); `/vendas/shopee` com dado desde a migration de 14/10 |
| Dado Shopee real | — | — | 1 loja **sandbox** CONNECTED, 1 pedido (READY_TO_SHIP, financeiro lido), 1 item de pedido, 1 item de catálogo, 0 vínculos manuais |
| Jobs (7 dias) | — | — | `shopee.orders.sync` 27, `shopee.order-financials.sync` 21, `shopee.items.sync` 17, `shopee.items.hydrate` 17 — **todos `done`, zero falhas** |
| Token | — | — | renovado sozinho (última renovação 14/10 10:20 UTC, vence 14:20; refresh até 13/11; autorização até 13/10/2027) |

Testes unitários na `main` (rodados em 14/10): `@sb/shopee` 24, worker
(handlers Shopee) 30, api (Shopee) 14, web (`lib/shopee-*`) 45 — todos
passam. Integração (RLS, RPCs) e e2e passam na CI da `main`.

**O que isso prova e o que não prova.** Prova, no sandbox: autorização,
renovação do token, leitura de pedidos, financeiro e catálogo de UMA loja com
UM pedido. **Não prova:** paginação real (mais de 100 pedidos ou itens),
conta principal com várias lojas, lojas reais (`live`), volume, rate limit,
backfill de 90 dias com dado, vínculo manual em produção, vendas (D-430) em
produção. Nenhuma loja real foi conectada: o Go Live (fatia 7) depende de
Cloud NAT com IP fixo e do cadastro no Console (`docs/SHOPEE.md` §6).

---

## 2. Identidade multicanal

| Conceito | Mercado Livre | Shopee | Regra |
|---|---|---|---|
| Marketplace | implícito (tabelas sem prefixo) | prefixo `shopee_` | contratos novos: coluna `marketplace` = `'ML'` / `'SHOPEE'` (nunca `channel`) |
| Conta | `ml_accounts.id` (uuid); `slug` na URL | `shopee_shops.id` (uuid); `shop_id` (bigint) é único **por ambiente** | o uuid identifica; nunca comparar `seller_id` com `shop_id` |
| Ambiente | só produção | `environment` = `sandbox` \| `live` | **sandbox nunca entra em total da empresa** |
| Pedido | `orders.id` (bigint) + `ml_account_id`; compra = `pack_id` | (`shopee_shop_id`, `order_sn` texto); um pedido tem vários itens | id externo só vale junto da conta |
| Item de pedido | uma linha por pedido (medido: 0 multi-linha em 340 mil) | `position` no pedido, substituído a cada leitura | — |
| Anúncio | `listings.mlb_id` (`^MLB`) + `variation_id` | (`shopee_shop_id`, `item_id`, `model_id`); unidade = variação, ou item sem variação | — |
| SKU canônico | `skus.id` | `skus.id` | **o único ponto comum entre canais** |
| Vínculo anúncio→SKU | `sku_listing_links` (+ eventos) | `shopee_sku_links` (+ eventos), manual vence o SKU do anúncio | tabelas separadas; nada cria SKU automaticamente |
| SKU na venda | `order_items.sku_id` gravado (D-020) | `shopee_order_items.sku_id` gravado (D-430): MANUAL > SKU_DO_ANUNCIO > SKU_DO_PEDIDO | congelado na última leitura do pedido |

Não há colisão de identificadores por construção: cada canal tem tabelas
próprias e toda chave externa leva a conta (uuid) junto.

**Avaliação da arquitetura (sem proposta de troca).** As cinco camadas já
existem separadas: adaptadores (`@sb/mercado-livre`, `@sb/shopee`), jobs no
worker por marketplace, persistência própria por marketplace (D-425 §1),
regras compartilhadas em `@sb/domain` e leituras por RPC. O que falta é só a
**camada de leitura comum**: hoje a convergência entre canais acontece apenas
no `skus.id`. O desenho que preserva o ML é convergir na LEITURA (views e RPCs
novas que unem os dois lados no SQL, cada um com a sua definição), não
generalizar `ml_accounts`, `orders` ou `daily_*`, que têm `ml_account_id NOT
NULL`, `^MLB` e cerca de 30 funções em cima (§4).

---

## 3. Contratos Shopee disponíveis (Agente 2 pode consumir)

Todos `security invoker`, recebem `p_organization_id` e respeitam a RLS de
quem chama. **Até D-433 a RLS da Shopee era por ORGANIZAÇÃO; com a
migration `20261014190000` passa a ser por LOJA** (ADMIN todas; os demais,
as de `user_shopee_shop_permissions`) — mesmas assinaturas, menos linhas
para quem não alcança a loja. Valores monetários em `numeric` (BRL, `currency` devolvido quando há);
ausente = NULO, nunca zero.

### 3.0 Contas dos dois marketplaces — `marketplace_accounts` (C-52, D-435, em produção)

View `security_invoker`, lida com `supabase.from("marketplace_accounts")`: uma linha por conta ML e por loja Shopee que o chamador alcança (D-175, D-433). Colunas: `marketplace` (`ML` | `SHOPEE`), `account_id`, `organization_id`, `name`, `slug` (só ML; os filtros salvos usam `account=<slug>`), `shop_id` (só Shopee), `environment` (ML sempre `live`; Shopee `sandbox`|`live` — **sandbox nunca entra em total**), `connection_status` (ML: PENDING/CONNECTED/REVOKED/ERROR; Shopee: CONNECTED/ERROR), `last_error`, `connected_at`, `orders_synced_at` (ML: última reconciliação de pedidos que serviu; Shopee: último avanço do marco — NULO = nunca) e `authorization_expires_at` (só Shopee). Sem paginação (dezenas de linhas por organização).

### 3.1 Lojas

| Contrato | Forma | Onde |
|---|---|---|
| `shopee_shops` (tabela, `select`) | `id`, `environment`, `shop_id`, `shop_name`, `region`, `shop_status` (NORMAL/BANNED/FROZEN, da Shopee), `status` (CONNECTED/ERROR, da conexão), `authorized_at`, `auth_expires_at`, `connected_at`, `last_error`, `orders_synced_until`, `items_synced_until` | produção |
| `get_shopee_shop_catalog_counts(p_organization_id)` | por loja: `anuncios`, `vinculados`, `ultima_leitura`; NULOS se o catálogo nunca foi lido | produção |

Frescor por loja: `orders_synced_until` (pedidos) e `items_synced_until`
(catálogo) — marcos no relógio da Shopee; NULO = nunca lido. Não existe
frescor do financeiro por loja (só por pedido, `financials_synced_at`).

### 3.2 Catálogo e vínculo

| Contrato | Parâmetros | Devolve | Paginação | Onde |
|---|---|---|---|---|
| `get_shopee_listings` | `p_organization_id`, `p_shopee_shop_id?`, `p_estado?` (VINCULADO, SEM_SKU_NO_ANUNCIO, SKU_FORA_DO_CATALOGO, AGUARDANDO_LEITURA), `p_busca?`, `p_limit` (≤200), `p_offset` | uma linha por unidade: loja, item, variação, `sku_anuncio`, status, preço, estoque, imagem, `sku_id`/`sku`/`sku_title`, `estado`, `vinculo_via` (MANUAL \| SKU_DO_ANUNCIO), `manual_link_id`, `sku_pelo_anuncio`, `details_error`, `total_count` | offset, `total_count` por janela | produção |
| `get_shopee_listings_summary` | `p_organization_id`, `p_shopee_shop_id?` | contadores por estado e `ultima_leitura` (a mais velha entre as lojas; NULA se alguma nunca foi lida) | — | produção |
| `get_sku_shopee_listings` | `p_organization_id`, `p_sku_id` | os anúncios Shopee de um SKU (≤200); `environment` da loja no fim (C-55, D-432) | — | produção; `environment` em código |
| `set_shopee_sku_link` / `remove_shopee_sku_link` | loja, item, variação, SKU, motivo | escrita (ADMIN/GESTOR/OPERADOR) | — | produção |

Conflito de vínculo = `manual_link_id` preenchido e `sku_pelo_anuncio`
diferente do `sku`. Anúncio sem vínculo = estados SEM_SKU_NO_ANUNCIO e
SKU_FORA_DO_CATALOGO. Produto com vários anúncios = `get_sku_shopee_listings`.
**A Central de Vinculações (`/vinculacoes`) é só do Mercado Livre.**

### 3.3 Vendas (D-430) — em produção desde 14/10

| Contrato | Parâmetros | Devolve |
|---|---|---|
| `get_shopee_sales_by_shop` | `p_organization_id`, `p_date_from`, `p_date_to` (datas de São Paulo) | uma linha por loja (inclusive sandbox, com `environment`): `pedidos`, `unidades`, `receita_bruta`, `pedidos_sem_receita`, `recebido`, `pedidos_sem_recebido`, `cancelados`, `com_devolucao`, `pedidos_sem_sku`, `ultima_leitura`, `connection_status` |
| `get_shopee_orders` | + `p_shopee_shop_id?`, `p_situacao?` (VALIDA, CANCELADA, NAO_PAGA), `p_limit` (≤200), `p_offset` | pedidos mais novos primeiro, com `itens` (jsonb: item, variação, quantidade, `sku_id`, `sku`, `vinculo_via`) e `total_count` |
| `shopee_sales_orders` (view) | — | a definição única do pedido de venda Shopee; base das duas RPCs |

Semântica (`docs/METRICS.md` 5S): venda válida = paga e fora de UNPAID,
CANCELLED, IN_CANCEL; dia = criação do pedido em São Paulo; receita bruta =
produtos com desconto da loja, sem frete; recebido = `escrow_amount`,
provisório até COMPLETED.

**Não existe para a Shopee:** recorte por SKU ou marca, custo, resultado,
margem, ranking, curva ABC, Ads, devoluções com valor, estoque.

### 3.4 Vendas por marketplace e o consolidado (C-53, D-436) — em código

| Contrato | Parâmetros | Devolve |
|---|---|---|
| `get_marketplace_sales_summary` | `p_organization_id`, `p_date_from`, `p_date_to` (datas de São Paulo), `p_marketplaces text[]` (nulo = só `ML`; `ML`, `SHOPEE`), `p_account_ids uuid[]` (ids de `marketplace_accounts`; nulo = todas as alcançadas) | linhas `nivel` = `TOTAL` (consolidado), `MARKETPLACE` (uma por marketplace com operação lida) e `CONTA` (uma por conta/loja, com `environment`): `compras`, `unidades`, `receita_bruta`, `pedidos_sem_receita`, `ticket_medio`, `pedidos_ml` (só ML), `recebido`/`pedidos_sem_recebido` (só Shopee), `ultima_atualizacao` |
| `get_marketplace_sales_daily` | os mesmos | por `dia`: uma linha por `marketplace` e a do total (`marketplace` nulo): `compras`, `unidades`, `receita_bruta`, `pedidos_sem_receita`; só dias com venda |

Regras para a tela: **nunca somar no navegador** — o TOTAL já vem; loja de
sandbox e loja nunca lida aparecem só em `CONTA` (a nunca lida com tudo NULO
= "—"); sem loja live lida, não há linha `MARKETPLACE` da Shopee; ids das
métricas em `docs/METRICS.md` 5T. Erros: marketplace fora de ML/SHOPEE e
período invertido são recusados pelo banco.

### 3.7 Curva ABC por marketplace (C-60, D-441) — em código

As três funções da Curva ABC de D-424 recebem, **no fim**, `p_marketplaces text[]` (`ML` e/ou `SHOPEE`; nulo = só ML, o resultado de antes) e `p_account_ids uuid[]` (ids de `marketplace_accounts`: conta ML ou loja Shopee). São recortes que recalculam a curva.

| Contrato | O que muda | Colunas novas |
|---|---|---|
| `get_sku_abc_analysis` | critério `compras` (pack do ML + pedido Shopee) e ordem `compras` | `purchases`, `class_purchases`, `revenue_ml`, `units_ml`, `purchases_ml`, `revenue_shopee`, `units_shopee`, `purchases_shopee`, `shopee_items_without_revenue`, `total_purchases`, `total_shopee_items_without_revenue` |
| `get_sku_abc_breakdown` | dimensão `marketplace` (rótulos Mercado Livre e Shopee); `conta` inclui as lojas (rótulo = nome da loja) | `purchases`, `shopee_items_without_revenue` |
| `get_sku_sales_by_account` | uma linha por SKU e conta ML **ou** loja Shopee | `marketplace`, `account_id`, `purchases`, `shopee_items_without_revenue` (na linha da loja, `ml_account_id` e `orders` são NULOS) |

**Com a Shopee no recorte:** `orders`, `total_orders` e `class_orders` NULOS (pedido do ML não soma com o da Shopee); critério `pedidos` RECUSADO (use `compras`); `coverage_days` NULO (fatia 5); `p_ml_account_id` RECUSADO (use `p_account_ids`). **Sem o ML no recorte:** `full_stock` NULO e `p_only_without_full` RECUSADO. Receita de um SKU = a conhecida; `shopee_items_without_revenue` diz quantos itens ficaram de fora. Sandbox nunca entra. `get_sku_abc_curve` (página do SKU) continua só ML.

### 3.6 Vendas por SKU entre marketplaces (C-59, D-439) — em código

| Contrato | Parâmetros | Devolve |
|---|---|---|
| `get_marketplace_sku_sales` | `p_organization_id`, `p_date_from`, `p_date_to`, `p_marketplaces text[]` (nulo = só ML), `p_account_ids uuid[]`, `p_sku_ids uuid[]`, `p_ordem` (`receita` \| `unidades`), `p_limit` (≤500), `p_offset` | uma linha por SKU (e o balde sem SKU, `sku_id` NULO): `sku`, `sku_title`, `unidades_ml`/`receita_ml`/`compras_ml`, `unidades_shopee`/`receita_shopee`/`itens_shopee_sem_receita`/`compras_shopee`, o total (`unidades`, `receita_bruta`, `compras`) e `total_count` |
| `get_sku_sales_by_marketplace_account` | `p_organization_id`, `p_sku_id`, `p_date_from`, `p_date_to` | `nivel` TOTAL (só operação) e CONTA (uma por conta ML e loja Shopee, com `environment`): `unidades`, `receita_bruta`, `itens_sem_receita`, `compras`, `preco_medio` (NULO se há item de receita desconhecida) |
| `shopee_sales_items` (view) | — | o grão de SKU da Shopee: item de pedido com a situação, o dia e `receita_item` |

Coluna de marketplace nula = sem venda naquele canal no período (não é zero). Sandbox fica fora das somas; aparece só na linha da loja.

### 3.15 Metas por marketplace (C-66, D-473) — em produção

`get_meta_do_mes(p_organization_id, p_mes, p_hoje)` — a mesma da central (D-395), sem parâmetro novo. As chaves de sempre continuam no topo e são as do GERAL; a resposta ganha `escopos`.

| Chave | Quando vem | Série e meta |
|---|---|---|
| `escopos.GERAL` | sempre (igual ao topo) | ML + Shopee; meta de `monthly_goals` (nula sem meta) |
| `escopos.ML` | sempre | `daily_account_metrics`; meta de `monthly_goals_marketplace` (`ML`; nula sem meta) |
| `escopos.SHOPEE` | sempre como chave; **NULA** sem loja live com pedidos lidos, ou para quem não alcança a loja | vendas válidas das lojas live (C-53); meta de `monthly_goals_marketplace` (`SHOPEE`) |

Cada escopo traz os mesmos campos do topo (realizado, atingimento, ritmo, projeção, perfil, datas comerciais, ano anterior). **GERAL = ML + SHOPEE sempre**: pedido de loja live ainda não lida não entra em nenhum. Num mês que atravessa o Go Live, o GERAL muda de base a partir da primeira leitura de pedidos da loja live — a tela avisa. **A projeção não soma entre escopos:** cada um usa a janela mais longa que o próprio histórico cobre (28 → 14 → 7 dias), e uma loja recém-conectada projeta pelo ritmo curto dela (D-473 item 6).

`monthly_goals_marketplace` (organização, `month` com dia 1, `marketplace` `ML`|`SHOPEE`, `revenue_goal > 0`, `note` ≤ 300): única em (organização, mês, marketplace) — upsert com `onConflict: "organization_id,month,marketplace"`; membro lê, ADMIN/GESTOR grava. A meta GERAL continua em `monthly_goals`. Antes da migration: a chave `escopos` não vem e a tabela não existe (PGRST205/42P01).

### 3.14 Busca universal com a Shopee (C-57, D-467) — em produção

`search_entities(p_organization_id, p_query)` — a mesma da paleta e da `/busca`, estendida (não há segunda busca).

| Coluna | O que é |
|---|---|
| `entity_type`, `label`, `sublabel`, `href` | as de antes (D-060) |
| `marketplace` | `'ML'`, `'SHOPEE'` ou nulo (SKU, fornecedor, compra, NF-e) |
| `entity_id` | o id do destino: sku_id, item_id, order_sn, id da loja, do caso, da nota |
| `account_id` | a conta do ML ou a loja Shopee; nulo quando não se aplica |

| Tipo novo | Casa | Destino |
|---|---|---|
| `loja` | nome da loja, `shop_id` exato | `/contas` (a de teste com o sublabel "Shopee · teste") |
| `anuncio_shopee` | nome, SKU do item ou da variação (trecho), `item_id` exato — só loja live, sem item apagado | `/anuncios/shopee?loja=<loja>&q=<item_id>` |
| `pedido_shopee` | prefixo do `order_sn` (letra, dígito, hífen; 2 a 40), sem diferenciar maiúscula — só loja live | `/vendas/shopee?loja=<loja>&from=<dia>&to=<dia>&pedido=<order_sn>` (o dia de São Paulo do pedido) |

`get_shopee_orders` ganha `p_order_sn` no fim (o `order_sn` exato, sem diferenciar maiúscula; nulo = a lista de sempre). O pedido de venda do ML continua fora até haver destino (D-060). Até 5 por tipo; a RLS decide por conta e por loja.

### 3.13 Demanda da Shopee na cobertura e na reposição (C-65, D-459) — em código

| Contrato | O que muda | Colunas novas |
|---|---|---|
| `get_stock_coverage` (e `get_stock_coverage_summary`) | `units_sold`, `avg_daily_sales`, `days_of_coverage`, `is_ruptura` e `units_15d`…`units_90d` = ML + Shopee; SKU só da Shopee entra | `units_sold_ml`, `units_sold_shopee`, `units_30d_shopee`, `units_90d_shopee` |
| `get_purchase_suggestions` (e `get_purchase_state_counts`) | janelas, taxa de 30 dias, recusas, estado, cobertura e sugestão sobre ML + Shopee | `units_30d_shopee`, `units_90d_shopee` |
| `get_replenishment_overview` | herda; as linhas do jsonb levam as duas colunas | — |
| `get_purchase_order_suggestions` | herda; as linhas levam `units_30d_shopee` | — |
| `get_replenishment_reach` | `skus_com_venda_30d` soma a Shopee; SKU só da Shopee entra no universo | — |

**Demanda da Shopee:** unidades das vendas válidas (5S) das lojas live, por SKU e dia de São Paulo; loja de teste e cancelada fora. **A parte da Shopee é NULA sem loja live com pedidos lidos** (sem loja, só a de teste, ou real nunca lida) e 0 com ela sem venda; quem não tem permissão na loja vê NULA. `history_days_90` segue no ML (SKU só da Shopee pode sair como histórico curto). `get_sku_dashboard` não muda. **Ordem em produção:** esta migration antes do Go Live com loja real.

### 3.12 Repasse da Shopee (C-64, D-451) — em código

| Contrato | Parâmetros | Devolve |
|---|---|---|
| `get_shopee_repasse_overview` | `p_organization_id`, `p_date_from`, `p_date_to`, `p_account_ids uuid[]` | pelo **dia da liberação** (São Paulo): `nivel` TOTAL (só loja live lida) e CONTA (nunca lida = NULO): `cobertura_completa`, `lido_ate`, `liberado`, `pedidos_liberados`, `liberacoes_sem_valor`, `previsto` (o `escrow_amount` dos mesmos pedidos, com financeiro lido), `pedidos_com_previsto`, `diferenca` (todas as liberações do pedido − previsto), `pedidos_divergentes` |
| `get_shopee_repasse_daily` | os mesmos | uma linha por dia com liberação, só lojas live: `liberado`, `pedidos`, `liberacoes_sem_valor` (a soma fecha com o TOTAL) |
| `get_shopee_repasses` | os mesmos + `p_order_sn`, `p_limit` (1–200), `p_offset` | cada liberação: `shopee_shop_id`, `shop_name`, `environment`, `order_sn`, `released_at`, `payout_amount`, `previsto`, `diferenca_do_pedido`, `liberacoes_do_pedido`, `order_status`, `shopee_created_at`, `total_count` |
| `get_shopee_repasse_pendente` | `p_organization_id`, `p_account_ids uuid[]` | retrato de agora, TOTAL e CONTA: `pedidos`, `a_liberar`, `pedidos_sem_financeiro`, `pedidos_completos`, `pedidos_com_devolucao`, `mais_antigo`, `lido_desde`, `lido_ate` |

**É o realizado ao lado do previsto:** o repasse não muda o recebido nem o resultado (C-58/C-61). O liberado é do dia em que o dinheiro saiu, não o da venda — não comparar com a receita do mesmo período. O "a liberar" só conta pedidos criados depois do início da leitura (`lido_desde`). Até a conferência no sandbox, a unidade de `payout_amount` não está confirmada: uma `diferenca` enorme em todos os pedidos é sinal disso, não de cobrança.

### 3.11 Ads da Shopee (C-63, D-449) — em código

| Contrato | Parâmetros | Devolve |
|---|---|---|
| `get_shopee_ads_overview` | `p_organization_id`, `p_date_from`, `p_date_to`, `p_account_ids uuid[]` | `nivel` TOTAL (só loja live com Ads lido) e CONTA (uma por loja; nunca lido = NULO): `cobertura_completa` (o período inteiro, até hoje, dentro da leitura), `dias_lidos`, `dias_sem_gasto` e `dias_sem_venda` (D-455: fora do ROAS/ACOS), `investimento`, `receita_ads` (amplo), `receita_ads_direta`, `pedidos_ads`, `cliques`, `impressoes`, `roas`, `acos`, `receita_bruta` (vendas válidas, 5S), `tacos`, `ultima_atualizacao` |
| `get_shopee_ads_daily` | os mesmos | uma linha por dia com dado, só lojas live: `investimento`, `receita_ads`, `receita_ads_direta`, `pedidos_ads`, `cliques`, `impressoes`, `roas`, `acos` |

**É o Ads CPC da loja, não o total:** o GMV Max de loja pode ficar de fora (a documentação não diz) — a tela deve rotular "Ads CPC" e **não** descontar do resultado da venda; isso espera a conferência com loja real. Loja lida sem anúncio = 0; com `cobertura_completa = false`, os números são só dos dias lidos. Não soma com o Ads do ML.

### 3.10 Devoluções da Shopee (C-62, D-447) — em código

| Contrato | Parâmetros | Devolve |
|---|---|---|
| `get_shopee_returns` | `p_organization_id`, `p_date_from`, `p_date_to` (criação, dia de São Paulo), `p_account_ids uuid[]`, `p_status text[]`, `p_order_sn`, `p_limit` (≤200), `p_offset` | uma linha por devolução: loja (`shop_name`, `environment`), `return_sn`, `order_sn`, `status`, `reason`, `reassessed_reason`, `return_solution` (`RETURN_REFUND` \| `REFUND`), `refund_amount`, `amount_before_discount`, `currency`, `needs_logistics`, `negotiation_status`, `seller_proof_status`, `seller_compensation_status`, `return_refund_type`, `due_date`, `return_seller_due_date`, criação/atualização, `itens` (jsonb: `item_id`, `model_id`, `nome`, `quantidade`, `preco`, `sku_id`, `sku`, `vinculo_via`) e `total_count` |
| `get_shopee_returns_summary` | `p_organization_id`, `p_date_from`, `p_date_to`, `p_account_ids uuid[]` | `nivel` TOTAL (só loja live com as devoluções já lidas) e CONTA (uma por loja; nunca lida = NULO): `devolucoes`, `pedidos_com_devolucao`, `so_reembolso`, `unidades`, `valor_reembolso` (o que a Shopee informa; loja lida sem devolução = 0) e `por_situacao` (jsonb `{SITUACAO: {devolucoes, valor_reembolso, unidades}}`) |

**A situação vem como a Shopee manda** (REQUESTED, ACCEPTED, CANCELLED, JUDGING, CLOSED, PROCESSING, SELLER_DISPUTE): a documentação não diz em qual o reembolso foi pago, então a tela não deve chamar o valor de "reembolsado" — é o "valor de reembolso informado". Nada do comprador é guardado. O efeito no recebido já está na composição (C-61, em "outros").

### 3.9 `/produtos` com a Shopee (C-56, D-445) — em código

`get_products_overview` (mesma assinatura; devolve `jsonb`). **Na linha:** `listing_count` e `units_sold_90d` continuam do ML; novos `shopee_listing_count` (anúncio Shopee vinculado ao SKU, um por item, só loja live) e `shopee_units_sold_90d` (pedido válido de loja live, 90 dias) — NULOS quando a organização não tem loja Shopee live. **Filtros:** `p_listing`/`p_sales` = `COM` (em algum marketplace), `SEM` (em nenhum), `SO_ML`, `SO_SHOPEE`, `AMBOS`. **Facetas** `anuncios` e `vendas`: `todos`, `com`, `sem`, `so_ml`, `so_shopee`, `ambos` (com + sem = todos; so_ml + so_shopee + ambos = com). **Resumo:** `sem_anuncio` e `sem_venda_90d` dos dois marketplaces, `sem_anuncio_ml` e `sem_venda_90d_ml` (o cartão de antes) e `tem_shopee`. Loja de teste nunca conta. Sem loja live, tudo como antes.

### 3.8 Composição do faturamento da Shopee (C-61, D-443) — em código

Todas com `p_organization_id`, `p_date_from`, `p_date_to`, `p_account_ids uuid[]`, sobre os MESMOS pedidos cobertos do C-58 (lidos de `get_shopee_faturamento_pedidos`, a definição única).

| Contrato | Devolve |
|---|---|
| `get_shopee_faturamento_composicao` | `nivel` TOTAL (só lojas live lidas) e CONTA (uma por loja, com `environment`; nunca lida = NULO): `pedidos_cobertos`, `receita_coberta`, `comissao`, `taxa_servico`, `taxa_transacao`, `frete_loja`, `frete_devolucao`, `cupom_loja`, `afiliados`, `taxa_por_pedido`, `outros`, `recebido_coberto`. **receita_coberta − componentes − outros = recebido_coberto** em toda linha. Informativos fora da cascata: `comissao_liquida`, `taxa_servico_liquida` (só Brasil), `cupom_shopee`, `moedas_shopee`, `desconto_shopee`, `pedidos_com_ajuste`, `ajustes` (depois do escrow; o recebido não os inclui) |
| `get_shopee_faturamento_diario` | uma linha por dia de São Paulo com pedido: `pedidos`, `receita_bruta` (NULA no dia só de receita desconhecida), `pedidos_sem_receita`, `pedidos_cobertos`, `receita_coberta`, `recebido_coberto`, `custo_produtos`, `resultado_venda` (com os ajustes, D-485), `margem_venda`; os dias somam o TOTAL do C-58 |
| `get_shopee_faturamento_por_sku` (+ `p_ordem` `receita` \| `margem`, `p_limit` ≤100) | uma linha por SKU, **só pedidos de um SKU** (sem rateio do recebido): `unidades`, `pedidos`, `receita_bruta`, `pedidos_cobertos`, `receita_coberta`, `recebido_coberto`, `custo_produtos`, `resultado_venda`, `margem_venda`, `custo_atual`, `total_count`, `pedidos_varios_skus`, `receita_varios_skus` (o que ficou de fora). `margem` = menor margem, só com cobertos |
| `get_shopee_faturamento_pedidos` | a definição por pedido (cobertura, custo, alíquota, componentes); para conferência e drill-down |

**Componentes, pelos termos da fórmula oficial do `escrow_amount`:** comissão `commission_fee`; serviço `service_fee`; transação `seller_transaction_fee`; frete da loja = `actual_shipping_fee − buyer_paid_shipping_fee − shopee_shipping_rebate − shipping_fee_discount_from_3pl` (negativo = sobrou; **não** é o `final_shipping_fee`, que veio −7,18 num pedido sem custo para a loja); devolução = `reverse_shipping_fee + final_return_to_seller_shipping_fee`; cupom da loja = `voucher_from_seller + seller_coin_cash_back`; afiliados `order_ams_commission_fee`; por pedido `seller_order_processing_fee`. **`outros` pode ser negativo** (crédito, p.ex. repasse de desconto da Shopee). Componente que nenhum pedido coberto informa = NULO. Conferido na documentação e num pedido de sandbox sem taxas: com loja real, se a comissão do Brasil fechar pela líquida, a diferença aparece em `outros`. **D-483 (leitura real, 16/10):** o `outros` era, em 100% dos cobertos, a taxa de proteção de envio (`shipping_seller_protection_fee_amount`). Fase 1: `_pedidos` e `_composicao` trazem no fim `protecao_envio` (nula sem o campo) e `outros_restante` (o outros sem a taxa, no SQL); o `outros` segue o de antes. **receita − componentes − protecao_envio − outros_restante = recebido.** Fase 2 (migration `20261016200000`, depois da D-492 no ar): `outros` = o restante, `outros_restante` sai e `protecao_envio` fica — **receita − componentes − protecao_envio − outros = recebido**.

**C-58 (D-443):** o TOTAL de `receita_bruta` soma como a linha da loja (loja lida sem pedido = 0).

### 3.5 Faturamento da Shopee (C-58, D-437) — em código

`get_shopee_faturamento(p_organization_id, p_date_from, p_date_to, p_account_ids uuid[])`: linhas `TOTAL` (lojas live já lidas) e `CONTA` (uma por loja, com `environment`; nunca lida = tudo NULO). Colunas: `pedidos`, `receita_bruta`, `pedidos_sem_receita`, `pedidos_cobertos`, `receita_coberta`, `recebido_coberto`, `custo_produtos`, `resultado_venda`, `margem_venda` (fração), `pedidos_definitivos`/`resultado_definitivo` (COMPLETED), `pedidos_provisorios`/`resultado_provisorio`, `pedidos_sem_financeiro`, `pedidos_sem_sku`, `pedidos_sem_custo`, `pedidos_custo_atual`, `pedidos_sem_aliquota`, `imposto_coberto`, `resultado_apos_imposto`, `margem_apos_imposto`, `ultima_atualizacao`, `ajustes_cobertos` (D-485, no fim: os ajustes depois do repasse dos cobertos, negativo = cobrado). **D-485:** resultado (e definitivo, provisório e após imposto) = recebido + `ajustes_cobertos` − custo; `recebido_coberto` continua o escrow. A coluna só existe depois da migration `20261016220000`: a tela lê pela presença. **D-487** (no fim, depois da migration `20261016230000`): `investimento_ads` (o Ads CPC da loja no período; NULO sem a leitura de Ads cobrindo o período ou com dia lido sem o gasto), `ads_rateado` (× receita coberta ÷ receita bruta; no TOTAL, sobre a cobertura do TOTAL), `resultado_contribuicao` (após imposto − `ads_rateado`) e `margem_contribuicao` (÷ receita coberta) — a regra do 5K do ML; NULOS sem alíquota. **Não somar com o resultado do ML** (`get_faturamento`): as duas contas têm componentes diferentes (METRICS 5U × 5F) — a tela mostra por marketplace. Qual resultado exibir (todos, definitivo ou provisório) é decisão de tela/dono; os três vêm prontos.

---

## 4. Contratos do Mercado Livre que as telas usam hoje

Mapeamento de 14/10 (leitura das telas e da última migration de cada RPC).
**Todo contrato de venda, faturamento, ABC, cobertura e anúncio é do Mercado
Livre**, e o filtro de conta é sempre UM `p_ml_account_id uuid default null`
(nulo = todas). Nenhuma RPC aceita lista de contas, slug ou marketplace.

| Tela | Contratos (última migration) | Filtros que já existem no backend | Base ML |
|---|---|---|---|
| `/vendas` (`?account=<slug>`) | `get_sales_summary`, `get_sales_daily_series`, `get_sales_expanded_summary` (coluna `taxas_ml`), `get_sales_today_summary`, `get_sales_top_skus` | período, UMA conta, marca (`p_supplier_brand`, `p_sem_marca`); sem `p_organization_id` (escopo pela RLS) | `daily_sku_metrics`, `daily_account_metrics`, `orders`, `order_items` |
| `/faturamento` (`?account=`) | `get_faturamento` (jsonb com `por_conta`), `get_ads_overview` | período, UMA conta, `p_detalhe` | `orders`, `order_items`, `order_financials`, custo, Ads |
| `/central` e sub-rotas | `get_faturamento` ×3, `get_ads_overview`, `get_meta_do_mes` (sem conta), `get_detector_frete`, `get_sinais_ads`, `get_quem_paga_frete`, `get_ranking_produtos` | período e UMA conta onde há | `daily_account_metrics`, `shipping_sales`, Ads, `orders` |
| `/produtos` | `get_products_overview`, `get_sku_curation*`, `get_stock_coverage`, `get_sku_dashboard` | sem conta nem período; "tem anúncio/tem venda" só ML | `listings`, `sku_listing_links`, `daily_sku_metrics` |
| `/anuncios` (`?conta=`), `/anuncios/[MLB]` | `get_listings_dashboard`, `..._counts`, `get_listing_dashboard_summary`, `get_fulfillment_overview`, `get_listing_content_change_analysis` | período, UMA conta, estado, vínculo, estoque, Full, promoção | `listings`, `daily_listing_*`, `fulfillment_stock_snapshots` |
| `/curva-abc` (`?conta=`) | `get_sku_abc_analysis`, `get_sku_abc_breakdown`, `get_sku_sales_by_account` | período e anterior, UMA conta, marca, categoria, critério | `daily_sku_metrics`, Full |
| `/skus/[id]` | `get_sku_dashboard`, `get_sku_listings`, `get_sku_abc_curve`, `get_sku_timeline`, `get_price_changes`, `get_sku_sales_breakdown` (uma linha por conta ML), baseline, eventos; **`get_sku_shopee_listings`** à parte | SKU, período, conta | ML; Shopee só o painel de anúncios |
| `/vinculacoes` (`?conta=`) | `get_listings_link_overview`, `get_link_integrity`, `get_listing_link_suggestions`, escritas de vínculo | período, UMA conta | só ML |
| `/estoque`, `/reposicao` | `get_stock_balances`, `get_stock_summary`, `get_replenishment_overview` | marca, categoria, busca | Full e `daily_sku_metrics` (a Shopee **não pode** entrar antes da fatia 5) |
| `/sincronizacao` | `get_sync_health` (`sync_runs` por conta ML), `get_processing_health`, `ml_accounts.backfill_covered_until`, `get_job_failures` | organização | só ML; o veredito de frescor é calculado na web |
| `/saude`, `/integracoes` | `get_system_health` (genérico sobre `job_runs`) | — | os jobs `shopee.*` aparecem, mas `JOB_CADENCE_MIN` (`apps/web/lib/sync-health.ts`) não tem chave `shopee.*`: sem veredito de atraso |
| `/contas` | `get_ml_account_cards`; `shopee_shops` + `get_shopee_shop_catalog_counts` | organização | os dois, em chamadas separadas |

As cinco tabelas `daily_*` (`listing`, `sku`, `account`, `listing_visits`,
`ads_campaign`) têm `ml_account_id NOT NULL` com FK para `ml_accounts`, e
`daily_listing_*` exige `^MLB`. Também são presas ao ML: `orders`,
`order_items`, `order_financials`, `listings`, `sku_listing_links`,
`link_candidates`, `fulfillment_stock_snapshots`, `metric_refresh_state` e
`sync_runs`. **Nenhum objeto fora da família `shopee_*` lê a Shopee.**

Identidade de conta na URL: `?account=<slug>` em `/vendas`, `/faturamento`,
`/central`, `/central/produtos`; `?conta=<slug>` em `/anuncios`,
`/curva-abc`, `/vinculacoes`; `saved_filters.params` guarda esses slugs. Slug
desconhecido cai em "todas as contas" sem aviso.

**Consequência para o "Todos":** misturar a Shopee em qualquer RPC acima
mudaria número do ML ou exigiria reescrever o grão. Por isso o consolidado é
contrato NOVO (E4), e as RPCs do ML continuam como estão.

---

## 5. Semântica: o que pode somar entre canais

| Métrica | ML | Shopee | Soma? |
|---|---|---|---|
| Unidades | `SUM(order_items.quantity)` válidos | `SUM(quantity)` válidos | **sim** |
| Receita bruta | `orders.total_amount` (produtos, com o desconto do vendedor no preço, sem frete) | `order_discounted_price` (produtos com desconto da loja, sem frete, antes dos cupons da Shopee); NULO com item de preço 0 sem financeiro | **sim, com `pedidos_sem_receita` ao lado** |
| Pedidos | `orders.id` = **uma linha de item** (o carrinho é o `pack_id`) | `order_sn` = **o carrinho** | **não como "pedidos"**. Somar `pedidos_por_pack` (ML) com pedidos Shopee = **compras** |
| Ticket médio | receita ÷ compras (pack) | receita ÷ pedidos | sim, recalculado no SQL sobre a soma (nunca média de médias) |
| Cancelados | `cancelled` + `pending_cancel` | `CANCELLED` + `IN_CANCEL` | sim, como contagem de compras canceladas |
| Recebido | `margem_operacional_pedido` = bruto − comissão − frete do vendedor, **só pedidos cobertos** | `escrow_amount` = já desconta comissão, taxa de serviço, taxa de transação, frete, cupons da loja, afiliados | **NÃO.** Componentes diferentes; o da Shopee é mais completo. Mostrar por canal, com a definição de cada um |
| Resultado / margem | `get_faturamento` (5F), sobre pedidos cobertos | não existe | não existe para a Shopee |
| Ads, TACoS | Mercado Ads | não integrado | não |
| Histórico | 365 dias | **90 dias** (primeira leitura) | comparação com período anterior > 90 dias subestima a Shopee: declarar a cobertura |

---

## 6. Riscos e lacunas encontrados

| # | Tipo | O quê | Evidência | Gravidade hoje |
|---|---|---|---|---|
| R0 | publicação | ~~Migration de D-430 fora de produção~~ — **resolvido em 14/10** (E0): migration aplicada e worker em `562b1e60` | `schema_migrations` de produção; `APP_COMMIT=562b1e60` | — |
| S1 | segurança | RLS das tabelas `shopee_*` é por **organização** (`accessible_orgs`); a do ML é por **conta** (`accessible_accounts`, `user_account_permissions`). Um usuário restrito a uma conta ML vê todas as lojas Shopee, com pedidos e financeiro. Contraria "respeitar permissões por conta" (`PRODUCT_REQUIREMENTS.md`) | migrations `20261013*`; D-429 §2 admite | **corrigido em produção (D-433)**; era latente (todo membro não-ADMIN de produção tem todas as contas ML, medido 14/10) |
| R1 | confiabilidade | **Pedido envenenado trava o financeiro da loja inteira.** Um erro definitivo da Shopee em UM pedido faz a execução falhar antes dos demais; o pedido nunca lido volta primeiro (`order by financials_synced_at nulls first`) em toda execução seguinte. Além disso, `common.error_not_found` nunca é reconhecido como "sem financeiro": o filtro compara o código SEM prefixo com a forma COM prefixo. É o defeito que D-428 corrigiu no catálogo, sem o espelho aqui | leitura de `shopee-order-financials-sync.ts`; sonda sobre `@sb/shopee` (`common.error_not_found` → `semFinanceiro=false`) | **corrigido em produção (D-432)**; era alto com volume real |
| R2 | integridade | O pedido é gravado em 4 chamadas sem transação (upsert do pedido → apaga itens → insere itens → resolve SKU). Falha no meio deixa pedido sem itens até a próxima leitura. Duas execuções na mesma loja (fila com 2 em paralelo; encadeamento do backfill + gatilho horário) podem gravar fora de ordem: o upsert não compara `update_time` e o marco é sobrescrito sem `greatest` | `shopee-orders-sync.ts` | **corrigido em produção (D-432)** |
| R3 | operação | Janela com mais de 200 páginas lança erro genérico, tratado como passageiro: a mesma janela se repete para sempre | `listarJanela` | **corrigido em produção (D-432)**: falha sem repetir |
| R4 | observabilidade | Shopee fora de `/sincronizacao`, do vigia de sincronização parada (D-417/D-418 lê só `ml_accounts`) e das notificações. Loja em ERROR, marco parado ou autorização perto de vencer (`auth_expires_at`) não avisam ninguém — o modo de falhar de D-217. Em `/saude` os jobs `shopee.*` aparecem, mas sem veredito de atraso (`JOB_CADENCE_MIN` não os conhece — arquivo do Agente 2) | `vigia_da_sincronizacao`; `apps/web/lib/sync-health.ts` | **corrigido em produção (D-435)** para loja parada e em ERROR; o veredito em `/saude` é a T1 do Agente 2 (C-09); autorização perto de vencer ainda sem aviso (só na view) |
| R5 | credencial | Não há "desconectar loja" no app; revogar exige o painel da Shopee, e a loja só vai para ERROR quando a renovação é recusada | api e `/contas` | baixa |
| R6 | cobertura | Histórico Shopee de 90 dias (ML: 365) | `PRIMEIRA_LEITURA_S` | declarar na tela |
| R7 | desempenho (ensaio feito em 16/10, D-479: o faturamento da Shopee corrigido; o resto abaixo de 0,7 s em 90 dias com 40 mil pedidos) | `shopee_sales_orders` filtra pelo `dia` calculado e agrega os itens em LATERAL antes do filtro: não usa `shopee_orders_org_created_idx`. Irrelevante com 1 pedido; precisa ensaio como `authenticated` antes do Go Live e antes de virar base do "Todos" | definição da view | futura |
| R8 | integridade | `organization_id` de pedidos, itens e catálogo não é amarrado ao da loja (FK composta ou gatilho); só o worker escreve | migrations | **corrigido em produção (D-432)**: FK composta |
| R9 | financeiro (16/10, leitura real: o "outros" do C-61 é a taxa de proteção de envio, `shipping_seller_protection_fee_amount`, em 100% dos cobertos; os ajustes pós-escrow saem fora do repasse — `docs/SHOPEE.md` §8) | Devoluções (D-447, E7a), Ads CPC da loja (D-449, E7b) e repasse por pedido (D-451, E7c): em código; o GMV Max de loja, o extrato da carteira e a renda por pedido (`get_income_detail`), ainda não — esperam o sandbox. Reembolso (`seller_return_refund`, `drc_adjustable_refund`, `prorated_*_offset_return_items`) e retenções (`withholding_*`) existem só dentro do `order_income` (jsonb), com semântica não conferida. **No sandbox o pedido de teste veio com `escrow_amount` = `order_discounted_price` (149,90)**: as taxas não aparecem, então o sandbox não valida a fórmula das taxas — só loja real valida | `payment.ts`; o `order_income` do pedido de produção (94 chaves) | lacuna declarada |
| R11 | negócio (inferência a medir, achado do Agente 2) | O saldo vem da planilha do UpSeller, que já desconta a venda Shopee, mas a demanda da reposição (`get_purchase_suggestions`, `get_replenishment_overview`, cobertura) é só a do ML: para SKU que também vende na Shopee, a cobertura sai alta demais e a sugestão de compra baixa demais | leitura das RPCs (`daily_sku_metrics`) | a medir; entra na decisão da fatia 5 |
| R10 | acoplamento | Todas as agregações de vendas, faturamento, ranking, curva ABC, central e estoque são do Mercado Livre (§4) | §4 | é o trabalho da 6b |

---

## 7. Plano incremental

Cada etapa é uma fatia: migration versionada, testes, CI verde, publicação
na ordem migration → worker/api → web, e este documento atualizado com o
contrato entregue. Nenhuma etapa muda número do Mercado Livre: onde um
contrato novo também cobre o ML, há teste de equivalência contra a RPC atual.

### E0 — Publicar D-430 (ato do dono) — FEITA em 14/10

- **Escopo:** `migrations-producao.yml` com `20261014150000`; depois o worker
  (a resolução do SKU no lote) e a api.
- **Aceite:** `/vendas/shopee` em produção mostra a loja de teste; o próximo
  `shopee.orders.sync` grava `sku_id`/`vinculo_via` sem falha em `job_runs`.
- **Contrato entregue:** §3.3 em produção.

### E1 — Ingestão Shopee robusta (R1, R2, R3, R8) — em produção (D-432)

- **Escopo:** financeiro com `financials_error` e recuo de 1 dia na
  `shopee_orders_financials_pending` (o espelho de D-428: erro definitivo de
  um pedido grava e a fila segue); reconhecer `error_not_found`; RPC
  `service_role` que grava pedido + itens + SKU numa transação, sem regredir
  `shopee_updated_at`, e marco com `greatest`; janela grande vira falha não
  repetível; amarrar `organization_id` à loja; `get_sku_shopee_listings`
  devolve o `environment` da loja (C-55, coluna nova no fim).
- **Arquivos:** migration nova; `apps/worker/src/handlers/shopee-{orders-sync,order-financials-sync}.ts`
  e testes; `packages/shopee/src/payment.ts`; `packages/db/src/{types,rls.integration.test}.ts`.
- **Testes:** worker (pedido envenenado no meio do lote; gravação fora de
  ordem; janela grande); integração (transação, regressão recusada, fila com
  recuo, FK composta).
- **Aceite:** um pedido com erro definitivo não impede os outros; nenhum
  pedido fica sem itens; leitura velha não sobrescreve nova.
- **Contrato entregue:** nenhum novo; `financials_error` passa a explicar o
  "aguardando financeiro".

### E2 — Permissão por loja (S1) — em produção (D-433)

- **Escopo:** a mesma regra do ML: ADMIN vê todas as lojas; os demais, as
  concedidas. Conjunto `private.accessible_shopee_shops()`; as políticas das
  tabelas `shopee_*` passam de organização para loja; as RPCs `security
  invoker` herdam. A migration concede as lojas existentes a quem hoje tem
  TODAS as contas ML, para ninguém perder visão no dia.
- **Arquivos:** migration nova; `rls.integration.test.ts` (4 usuários do
  fixture); RPC de concessão para a tela de Usuários.
- **Aceite:** usuário sem a loja não lê pedido, financeiro, catálogo nem
  vínculo dela, por tabela e por RPC.
- **Contrato entregue:** concessão de loja (o Agente 2 põe na tela de
  Usuários).

### E3 — Contas multicanal e saúde (R4, R5) — em produção (D-435)

- **Escopo:** view `marketplace_accounts` (`security invoker`):
  `marketplace` ('ML' | 'SHOPEE'), `account_id` (uuid), organização, nome,
  `slug` do ML (os links e filtros salvos antigos usam `account=<slug>`),
  `shop_id` da Shopee, ambiente, status da conexão, último erro, frescor de
  pedidos e de catálogo, cobertura do histórico. A Shopee no vigia de
  sincronização parada e aviso de `auth_expires_at` a 30 dias. **Nomes SQL
  novos evitam `channel`**: `support_cases.channel` e `sync_runs.channel` já
  existem com outro sentido, e o parâmetro `canal` de `/atendimento` também.
- **Aceite:** o seletor Canal/Conta tem UMA fonte; loja parada gera
  notificação como a conta ML.
- **Contrato entregue:** `marketplace_accounts` — a lista de contas do seletor.

### E4 — Vendas por canal e "Todos" (fatia 6b, vendas) — em código (D-436)

- **Escopo:** `get_marketplace_sales_summary(p_organization_id, p_date_from,
  p_date_to, p_marketplaces text[], p_account_ids uuid[])`: uma linha por
  marketplace (e por conta, quando pedido) e a linha consolidada calculada
  no SQL. Somam (§5): compras (pack do ML + pedido Shopee), unidades,
  receita bruta (com os pedidos sem receita ao lado) e cancelados; o ticket
  é recalculado sobre a soma. Na consolidada ficam NULOS o recebido e os
  "Pedidos do Mercado Livre", que só existem por marketplace. Sandbox fora
  da consolidada (a linha volta com a marca). `p_account_ids` vem de
  `marketplace_accounts` (a URL leva UM valor com os ids separados por
  vírgula, porque os filtros salvos são `Record<string,string>`). Série
  diária por marketplace para gráfico. `p_marketplaces` nulo = só ML, o
  padrão de hoje. A view da Shopee passa a
  filtrar pelo intervalo em `timestamptz` (usa o índice), com ensaio como
  `authenticated`.
- **Testes:** equivalência (só ML = RPC atual do ML, número a número; só
  Shopee = `get_shopee_sales_by_shop`), permissão por conta e por loja,
  sandbox fora do total, sem receita contado à parte.
- **Contrato entregue:** o "Todos" de `/vendas`, filtrável por canal e conta.

### E5 — Faturamento Shopee — em código (D-437)

- **Escopo:** resultado = recebido − custo (`sku_cost_history` na data do
  pedido, KIT pelos componentes), sobre pedidos cobertos (financeiro lido e
  custo conhecido em todos os itens); ids próprios (`shopee_resultado_venda`,
  `shopee_margem_venda`), nunca "lucro líquido". Precisa da decisão do dono
  sobre usar o recebido provisório (pedido ainda não COMPLETED).
- **Contrato entregue:** linha Shopee em `/faturamento`, com cobertura.

### E6 — Grão de SKU, ranking e curva ABC — E6a (D-439), E6b (D-441) e E6c (`/produtos`, D-445) em código; o ranking com resultado da central fica para depois do Go Live (D-430 §5)

> O grão de SKU da Shopee ficou numa view (`shopee_sales_items`, D-439), não na tabela materializada prevista abaixo; materializar só se o volume pedir (medir no Go Live).

- **Escopo:** `daily_shopee_sku_metrics` (loja, `sku_id` com o balde nulo,
  dia), convergente como D-199, materializada pelo worker depois dos
  pedidos; leitura multicanal por canal. **Sugestão de compra e cobertura
  não leem a Shopee** até a fatia 5 (decisão do dono, 14/10).
- **Contrato entregue:** ranking e ABC com canal.

### E7 — Fontes financeiras que faltam (R9) e Live Push — E7a (devoluções, D-447), E7b (Ads CPC, D-449) e E7c (repasse, D-451) na `main`; E7d (push, D-453) em código

Devoluções (API `returns`), reembolso pelo `order_income`, lote do
financeiro (`get_escrow_detail_batch`, a conferir no sandbox), Ads da
Shopee, extrato/repasse e push de pedido. **Cada uma só depois de conferida
na documentação oficial e no sandbox** — nada disso está confirmado hoje.

### E8 — Go Live e estoque (fatias 7 e 5)

Infra (Cloud NAT com IP fixo, partner de produção) e decisões do dono. Antes
de conectar loja real: E1 pronta e o ensaio de volume de E4.
