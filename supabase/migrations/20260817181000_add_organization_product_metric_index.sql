-- ============================================================
-- ÍNDICE ORGANIZACIONAL PARA daily_product_metrics
-- ============================================================
--
-- Problema corrigido:
--
-- get_dashboard_top_products (20260810184348_add_dashboard_top_products.sql:92-102)
-- agrega daily_product_metrics filtrando por organization_id e faixa de
-- metric_date, sem ml_account_id. Os índices existentes são
-- daily_product_metrics_account_date_idx (ml_account_id, metric_date desc)
-- e daily_product_metrics_product_date_idx (product_id, metric_date desc):
-- nenhum dos dois começa por organization_id, então a agregação da tela
-- inicial não tem índice que a atenda.
--
-- Medido no projeto em 17/08/2026: daily_product_metrics tem 180.306
-- linhas e cresce na ordem de uma linha por produto/conta/dia.
--
-- As colunas do INCLUDE são exatamente as somadas pela função, o que
-- permite index-only scan sem visitar a heap. product_id entra no INCLUDE
-- porque o join com products precisa dele.
--
-- A mesma consulta serve o "quantos SKUs venderam hoje" de
-- get-dashboard-overview.ts, que filtra organization_id + metric_date =
-- hoje e depois units_sold > 0.
--
-- Deliberadamente NÃO indexado:
--
-- daily_account_metrics. Ela tem 1.478 linhas (uma por conta/dia, quatro
-- contas) e cresce cerca de 1.460 linhas por ano. Nesse volume o seq scan
-- é a escolha certa e um índice só adicionaria manutenção — mesmo
-- raciocínio já aplicado a ml_accounts.
--
-- Sem CONCURRENTLY de propósito: o supabase db push aplica cada migration
-- dentro de uma transação, e CREATE INDEX CONCURRENTLY não pode rodar em
-- transaction block. Em 180 mil linhas a construção leva poucos segundos,
-- bloqueando escritas mas não leituras. Se o volume crescer muito, criar
-- versões futuras manualmente com CONCURRENTLY, fora de transação.

create index if not exists daily_product_metrics_org_date_idx
on public.daily_product_metrics (
  organization_id,
  metric_date
)
include (
  product_id,
  orders_count,
  units_sold,
  gross_revenue,
  sale_fees,
  net_after_sale_fee
);

analyze public.daily_product_metrics;
