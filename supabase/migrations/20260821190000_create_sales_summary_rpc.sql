-- ============================================================
-- Totais de vendas por periodo — grao organizacao (Dashboard Geral, Fase 5A).
--
-- docs/METRICS.md lista "organizacao" como granularidade valida de toda
-- metrica de venda, mas as tabelas criadas em 20260821182620 materializam
-- so anuncio/SKU/conta. Esta funcao fecha o grao que faltava SEM duplicar
-- calculo: soma daily_account_metrics, que ja e o rollup correto por conta.
--
-- Por que somar daily_account_metrics e seguro aqui e nao violaria D-017/
-- D-050 ("nunca somar contagem distinta de grao inferior"): um pack_id (ou
-- order_id) pertence a exatamente uma conta do Mercado Livre — packs nao
-- atravessam contas, so atravessam anuncios/SKUs dentro da MESMA conta. Os
-- conjuntos de purchase_key por conta sao disjuntos por construcao, entao
-- SUM(purchases_count) entre contas equivale a COUNT(DISTINCT) direto no
-- grao organizacao. A mesma soma feita entre ANUNCIOS seria invalida (e o
-- teste de equivalencia da fase anterior prova isso: 3 anuncios podem somar
-- 3 enquanto o grao da conta correto da 2, porque um pack pode ligar dois
-- anuncios). Entre contas essa colisao nao existe.
-- ============================================================

create function public.get_sales_summary(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null
)
returns table (
  units_sold bigint,
  gross_revenue numeric,
  orders_count bigint,
  purchases_count bigint,
  average_ticket numeric,
  average_selling_price numeric,
  last_computed_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce(sum(m.units_sold), 0)::bigint as units_sold,
    coalesce(round(sum(m.gross_revenue), 2), 0) as gross_revenue,
    coalesce(sum(m.orders_count), 0)::bigint as orders_count,
    coalesce(sum(m.purchases_count), 0)::bigint as purchases_count,
    round(sum(m.gross_revenue) / nullif(sum(m.purchases_count), 0), 2) as average_ticket,
    round(sum(m.gross_revenue) / nullif(sum(m.units_sold), 0), 2) as average_selling_price,
    max(m.computed_at) as last_computed_at
  from public.daily_account_metrics m
  where m.metric_date between p_date_from and p_date_to
    and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
$$;

comment on function public.get_sales_summary(date, date, uuid) is
  'Totais de vendas no grao organizacao (ou de uma conta, se informada) para um periodo. security invoker: RLS de daily_account_metrics filtra as linhas antes da soma, sem duplicar has_account_access aqui.';

-- security invoker: nenhuma linha alcancavel sem RLS. A funcao nao amplia
-- acesso nenhum além do que authenticated já teria lendo daily_account_metrics
-- direto — só resume em SQL o que a UI precisaria somar em JavaScript
-- (proibido, docs/ARCHITECTURE.md secao 21).
revoke all on function public.get_sales_summary(date, date, uuid) from public, anon;
grant execute on function public.get_sales_summary(date, date, uuid) to authenticated, service_role;
