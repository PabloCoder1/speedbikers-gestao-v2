-- ============================================================
-- DUMP COMPLETO — rode cada bloco separado e me mande o resultado
-- (print de cada um serve, não precisa exportar CSV)
-- ============================================================

-- 1) Todas as tabelas do schema public + linhas estimadas
select
  relname as tabela,
  n_live_tup as linhas_estimadas
from pg_stat_user_tables
where schemaname = 'public'
order by relname;

-- 2) Todas as colunas de todas as tabelas (schema completo)
select
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position;

-- 3) Todas as funções (RPCs) criadas no schema public
select
  p.proname as funcao,
  pg_get_function_identity_arguments(p.oid) as argumentos
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname;

-- 4) Definição completa da função de rebuild de métricas
--    (pra confirmar se bate com o que está no repositório)
select pg_get_functiondef(
  'public.rebuild_sales_metrics_for_account_range(uuid, date, date)'::regprocedure
);

-- 5) Todos os triggers do schema public
select
  event_object_table as tabela,
  trigger_name,
  action_timing,
  event_manipulation,
  action_statement
from information_schema.triggers
where trigger_schema = 'public'
order by event_object_table, trigger_name;

-- 6) Todos os cron jobs agendados (pg_cron)
select jobid, schedule, command, nodename, active
from cron.job
order by jobid;

-- 7) Últimas 40 execuções dos crons (pra ver falhas silenciosas)
select jobid, runid, status, return_message, start_time, end_time
from cron.job_run_details
order by start_time desc
limit 40;

-- 8) Todas as contas Mercado Livre cadastradas
select
  id,
  code,
  oauth_app_code,
  display_name,
  seller_id,
  expected_seller_id,
  nickname,
  connection_status,
  is_active,
  connected_at,
  last_synced_at
from public.ml_accounts
order by code;

-- 9) Contagem de pedidos por conta e por status (visão geral, sem filtro de data)
select
  a.code as conta,
  o.status,
  count(*) as pedidos
from public.orders o
join public.ml_accounts a on a.id = o.ml_account_id
group by a.code, o.status
order by a.code, pedidos desc;

-- 10) Últimos sync_runs por conta (tipo, status, quando rodou, quantos processados)
select
  a.code as conta,
  sr.sync_type,
  sr.status,
  sr.started_at,
  sr.finished_at,
  sr.records_discovered,
  sr.records_processed,
  sr.records_upserted
from public.sync_runs sr
join public.ml_accounts a on a.id = sr.ml_account_id
order by sr.started_at desc
limit 40;

-- 11) daily_account_metrics dos últimos 30 dias, por conta
--     (é exatamente o que alimenta os cards "Faturamento 7/30 dias" no dashboard)
select
  a.code as conta,
  dam.metric_date,
  dam.total_orders,
  dam.paid_orders,
  dam.cancelled_orders,
  dam.units_sold,
  dam.gross_revenue,
  dam.sale_fees,
  dam.net_after_sale_fee,
  dam.updated_at
from public.daily_account_metrics dam
join public.ml_accounts a on a.id = dam.ml_account_id
where dam.metric_date >= current_date - interval '30 days'
order by a.code, dam.metric_date desc;

-- 12) Comparação direta: o que está em daily_account_metrics (pré-calculado)
--     x o que dá recalculando na hora, direto de orders/order_items,
--     pra semana benchmark 04/08-10/08/2026, conta SpeedBikers.
--     Se os dois números forem diferentes, confirma o bug do rebuild
--     "um passo atrás" descrito acima.
select
  'daily_account_metrics (pre-calculado)' as origem,
  sum(dam.gross_revenue) as receita_bruta,
  sum(dam.paid_orders) as pedidos_pagos,
  sum(dam.units_sold) as unidades
from public.daily_account_metrics dam
join public.ml_accounts a on a.id = dam.ml_account_id
where a.code = 'speedbikers'
  and dam.metric_date between '2026-08-04' and '2026-08-10'

union all

select
  'orders/order_items (recalculado agora, status=paid)' as origem,
  sum(coalesce(o.total_amount, 0)) as receita_bruta,
  count(*) as pedidos_pagos,
  sum(items.unidades) as unidades
from public.orders o
left join lateral (
  select sum(oi.quantity) as unidades
  from public.order_items oi
  where oi.order_id = o.id
    and oi.is_current = true
) items on true
join public.ml_accounts a
  on a.id = o.ml_account_id
where a.code = 'speedbikers'
  and o.status = 'paid'
  and (o.date_created at time zone 'America/Sao_Paulo')::date
      between '2026-08-04' and '2026-08-10';
