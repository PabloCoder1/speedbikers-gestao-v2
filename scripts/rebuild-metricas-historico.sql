-- ============================================================
-- Reconstrói as métricas diárias (daily_account_metrics e
-- daily_product_metrics) a partir dos pedidos/itens já gravados.
--
-- Rode DEPOIS do deploy da correção em sync-orders-preview.ts
-- (itens agora são gravados antes do recálculo das métricas).
--
-- Cobre 13/05/2026 até hoje, para todas as contas ativas que
-- tenham pedidos. Pode rodar mais de uma vez sem problema —
-- a função apaga e recalcula o intervalo inteiro.
-- ============================================================

select
  a.code,
  public.rebuild_sales_metrics_for_account_range(
    a.id,
    date '2026-05-13',
    (now() at time zone 'America/Sao_Paulo')::date
  ) as resultado
from public.ml_accounts a
where a.is_active = true
  and exists (
    select 1
    from public.orders o
    where o.ml_account_id = a.id
  );

-- Conferência: totais por mês depois do rebuild
-- (compare com o relatório oficial:
--   Junho R$ 742.090 | Julho R$ 1.015.474)
select
  a.code as conta,
  date_trunc('month', dam.metric_date)::date as mes,
  sum(dam.paid_orders)   as pedidos_pagos,
  sum(dam.units_sold)    as unidades,
  sum(dam.gross_revenue) as receita_bruta
from public.daily_account_metrics dam
join public.ml_accounts a on a.id = dam.ml_account_id
group by 1, 2
order by 1, 2;
