-- ============================================================
-- Diagnóstico: estrutura do banco + gap de faturamento
-- Rode cada bloco separadamente no Supabase SQL Editor
-- ============================================================

-- 1) Todas as tabelas do schema public
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;

-- 2) Todos os cron jobs agendados (pg_cron)
select jobid, schedule, command, nodename, active
from cron.job
order by jobid;

-- 3) Últimas execuções dos crons (útil para ver se algum ainda está
--    desligado ou falhando silenciosamente)
select jobid, runid, job_pid, database, username, status,
       return_message, start_time, end_time
from cron.job_run_details
order by start_time desc
limit 30;

-- 4) Definição ATUAL (rodando no banco) da função que alimenta o dashboard.
--    Serve para confirmar se bate com a migration
--    20260810183503_create_daily_sales_metrics.sql ou se houve alguma
--    alteração manual não versionada.
select pg_get_functiondef(
  'public.rebuild_sales_metrics_for_account_range(uuid, date, date)'::regprocedure
);

-- 5) DIAGNÓSTICO PRINCIPAL: faturamento por status de pedido,
--    na semana de referência (04/08/2026 a 10/08/2026), conta SpeedBikers.
--    Benchmark oficial ML: 1.445 vendas / 1.460 unidades / R$ 154.502,98
with order_totals as (
  select
    o.id,
    o.status,
    o.total_amount,
    coalesce(sum(oi.quantity), 0) as unidades
  from public.orders o
  left join public.order_items oi
    on oi.order_id = o.id
   and oi.is_current = true
  join public.ml_accounts a
    on a.id = o.ml_account_id
  where a.code = 'speedbikers'
    and (o.date_created at time zone 'America/Sao_Paulo')::date
        between '2026-08-04' and '2026-08-10'
  group by o.id, o.status, o.total_amount
)
select
  status,
  count(*)                                                 as pedidos,
  sum(unidades)                                            as unidades,
  sum(coalesce(total_amount, 0))                           as receita_bruta
from order_totals
group by status
order by receita_bruta desc;

-- 6) Total considerando TODOS os status (para comparar direto com o
--    benchmark oficial R$ 154.502,98)
with order_totals as (
  select
    o.id,
    o.total_amount,
    coalesce(sum(oi.quantity), 0) as unidades
  from public.orders o
  left join public.order_items oi
    on oi.order_id = o.id
   and oi.is_current = true
  join public.ml_accounts a
    on a.id = o.ml_account_id
  where a.code = 'speedbikers'
    and (o.date_created at time zone 'America/Sao_Paulo')::date
        between '2026-08-04' and '2026-08-10'
  group by o.id, o.total_amount
)
select
  count(*)                                                 as total_pedidos,
  sum(unidades)                                            as total_unidades,
  sum(coalesce(total_amount, 0))                           as total_receita_bruta
from order_totals;

-- 7) Pedidos sem NENHUM item "current" no período (isso também causaria
--    subcontagem de receita, independente do filtro de status)
select o.id, o.external_order_id, o.status, o.date_created
from public.orders o
left join public.order_items oi
  on oi.order_id = o.id
 and oi.is_current = true
where oi.id is null
  and o.ml_account_id = (select id from public.ml_accounts where code = 'speedbikers')
  and (o.date_created at time zone 'America/Sao_Paulo')::date
      between '2026-08-04' and '2026-08-10';
