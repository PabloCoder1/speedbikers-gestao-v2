-- ============================================================
-- D-465 — o "Full atual" (a captura dos últimos 3 dias) pelo índice da
-- organização e do instante
--
-- Nove funções leem o Full atual da organização inteira do mesmo jeito:
-- `where f.organization_id = p_organization_id
--    and f.captured_at >= now() - interval '3 days'`, seguido do
-- `distinct on (ml_account_id, inventory_id)` -- get_listings_dashboard,
-- get_listings_dashboard_counts, get_listings_link_overview,
-- get_purchase_suggestions, get_replenishment_overview,
-- get_fulfillment_overview, get_sku_abc_curve, get_sku_abc_analysis e
-- get_stock_summary. Nenhum índice começava por (organização, instante): o
-- banco percorria o `fulfillment_stock_snapshots_timeline_idx` (conta,
-- inventário, instante) de ponta a ponta e ia à tabela em CADA linha do
-- histórico só para conferir a organização.
--
-- Medido no Dev, como na D-461 (a consulta das funções, com o "agora" na
-- última captura do Dev, 14/09, porque o Dev não captura desde então): 28,7
-- mil linhas na janela de 3 dias; **30,8 mil páginas** sem o índice contra
-- **2,4 mil** com ele. O custo antigo cresce com o histórico (203 mil linhas
-- no Dev; produção captura todo dia), o novo só com a janela. Um índice que
-- cobrisse as colunas lidas leria ~1,4 mil, mas é maior e depende do vacuum
-- para não ir à tabela; o ganho que importa vem deste.
--
-- `get_sku_dashboard` e `get_stock_balances` filtram também pelo SKU e já
-- usam `fulfillment_stock_snapshots_sku_idx`; o `timeline_idx` continua: é
-- ele que serve a ordem do `distinct on` quando a conta está fixa.
-- Sem mudança de função nem de contrato.
-- ============================================================

create index if not exists fulfillment_stock_snapshots_org_captured_idx
  on public.fulfillment_stock_snapshots (organization_id, captured_at desc);

comment on index public.fulfillment_stock_snapshots_org_captured_idx is
  'O Full atual da organizacao (captured_at >= now() - 3 dias) sem percorrer o historico inteiro (D-465): nove funcoes leem assim.';
