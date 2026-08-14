-- ============================================================
-- Diagnóstico: por que faltam ~13% dos pedidos nos últimos 7 dias
--
-- Referência ML (07/08 a 13/08, conta SpeedBikers):
--   Vendas brutas:      R$ 266.710
--   Quantidade vendas:  2.605
--   Unidades vendidas:  2.668
--   Preço médio/un:     R$ 99,97
--
-- Nosso dashboard: R$ 233.256,41 / 2.322 un / R$ 100,45 por un.
-- Preço médio bate => faltam PEDIDOS, não valor.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Os crons estão realmente ligados?
--    orders_recent (jobid 10) é o que traz pedidos novos.
-- ------------------------------------------------------------
select jobid, jobname, schedule, active
from cron.job
order by jobid;

-- Últimas execuções: procure por status 'failed'
select jobid, status, return_message, start_time
from cron.job_run_details
order by start_time desc
limit 20;


-- ------------------------------------------------------------
-- 2) Dia a dia dos últimos 7 dias: pedidos, unidades, receita
--    e — o mais importante — pedidos SEM itens gravados.
--
--    Se "pedidos_sem_itens" for alto, o problema é sync de itens.
--    Se os totais de pedidos forem baixos, faltam pedidos mesmo.
-- ------------------------------------------------------------
select
  (o.date_created at time zone 'America/Sao_Paulo')::date as dia,
  count(distinct o.id)                                     as pedidos,
  count(distinct o.id) filter (where oi.id is null)         as pedidos_sem_itens,
  coalesce(sum(oi.quantity), 0)                            as unidades,
  round(coalesce(sum(coalesce(oi.unit_price, 0) * oi.quantity), 0), 2) as receita,
  min(o.first_seen_at)                                     as primeiro_sync,
  max(o.last_seen_at)                                      as ultimo_sync
from public.orders o
join public.ml_accounts a
  on a.id = o.ml_account_id
left join public.order_items oi
  on oi.order_id = o.id
 and oi.is_current = true
where a.code = 'speedbikers'
  and (o.date_created at time zone 'America/Sao_Paulo')::date
      between '2026-08-07' and '2026-08-13'
group by 1
order by 1;


-- ------------------------------------------------------------
-- 3) Total dos 7 dias, para comparar direto com o ML acima
-- ------------------------------------------------------------
select
  count(distinct o.id)                                     as vendas,
  coalesce(sum(oi.quantity), 0)                            as unidades,
  round(coalesce(sum(coalesce(oi.unit_price, 0) * oi.quantity), 0), 2) as vendas_brutas,
  round(
    coalesce(sum(coalesce(oi.unit_price, 0) * oi.quantity), 0)
    / nullif(sum(oi.quantity), 0)
  , 2)                                                     as preco_medio_unidade
from public.orders o
join public.ml_accounts a
  on a.id = o.ml_account_id
left join public.order_items oi
  on oi.order_id = o.id
 and oi.is_current = true
where a.code = 'speedbikers'
  and (o.date_created at time zone 'America/Sao_Paulo')::date
      between '2026-08-07' and '2026-08-13';


-- ------------------------------------------------------------
-- 4) O backfill ainda está rodando? Pedidos chegando agora?
--    Mostra quantos pedidos foram vistos pela primeira vez
--    em cada uma das últimas horas.
-- ------------------------------------------------------------
select
  date_trunc('hour', o.first_seen_at) as hora,
  count(*)                            as pedidos_novos
from public.orders o
join public.ml_accounts a
  on a.id = o.ml_account_id
where a.code = 'speedbikers'
  and o.first_seen_at >= now() - interval '12 hours'
group by 1
order by 1 desc;


-- ------------------------------------------------------------
-- 5) Estado das filas de sincronização
--    (se houver run 'running' preso ou 'failed', aparece aqui)
-- ------------------------------------------------------------
select
  sr.sync_type,
  sr.status,
  sr.started_at,
  sr.finished_at,
  sr.records_discovered,
  sr.records_processed,
  sr.records_upserted
from public.sync_runs sr
join public.ml_accounts a on a.id = sr.ml_account_id
where a.code = 'speedbikers'
order by sr.started_at desc
limit 20;
