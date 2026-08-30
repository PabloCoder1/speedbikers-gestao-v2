-- Saude da sincronizacao POR RECURSO (D-143) -- o ultimo item da Fase 5C.
--
-- A tela `/sincronizacao` media o frescor de UM recurso (orders) e contava
-- erros de 24h. O PRD (2026-08-28) pede por conta E por recurso, separando
-- backfill (finito, termina) de reconciliacao (permanente, cujo indicador
-- honesto e frescor), e distinguindo dado PUXADO do ML de dado PROCESSADO
-- por nos. O ROADMAP ja apontava o ganho barato: `sync_runs.items_processed`
-- e `ml_accounts.backfill_covered_until` "sao gravados e nunca lidos".
--
-- MEDIDO ANTES DE CONSTRUIR, e a medicao sozinha ja paga a tela:
--   * `visits`: 123 falhas em 145 execucoes (85%) -- 429 do Mercado Livre,
--     o rate limit conhecido de D-070/D-124, ate agora invisivel na UI;
--   * `fulfillment`: ZERO `done` em 130 execucoes -- todas `partial` (os 404
--     de itens mortos derrubam itens individuais) ou falhas;
--   * a tela atual nao mostrava NENHUM dos dois.
--
-- Sem porcentagem inventada (regra do PRD): nao existe denominador confiavel
-- para "quanto falta", entao a tela mostra datas, contagens e o cursor do
-- backfill -- nunca uma barra de progresso fabricada.
--
-- `EXPLAIN (ANALYZE, BUFFERS)`: 37 ms, 1.196 buffers, 32 linhas (4 contas x
-- recursos x canais). Nenhum indice novo -- o plano nao pediu.

create function public.get_sync_health(
  p_organization_id uuid
)
returns table (
  ml_account_id uuid,
  account_label text,
  resource text,
  channel text,
  last_run_at timestamptz,
  last_run_status text,
  last_run_reason text,
  last_success_at timestamptz,
  latest_record_at timestamptz,
  runs_24h bigint,
  failed_24h bigint,
  items_24h bigint
)
language sql stable security invoker set search_path = ''
as $$
  with ultima as (
    select distinct on (r.ml_account_id, r.resource, r.channel)
           r.ml_account_id, r.resource, r.channel,
           r.finished_at as last_run_at, r.status as last_run_status,
           left(r.reason, 200) as last_run_reason
    from public.sync_runs r
    where r.organization_id = p_organization_id
    order by r.ml_account_id, r.resource, r.channel, r.finished_at desc nulls last
  ),
  sucesso as (
    select r.ml_account_id, r.resource, r.channel,
           max(r.finished_at)      as last_success_at,
           max(r.latest_record_at) as latest_record_at
    from public.sync_runs r
    where r.organization_id = p_organization_id
      and r.status in ('done','partial')
    group by 1,2,3
  ),
  dia as (
    select r.ml_account_id, r.resource, r.channel,
           count(*)                                                   as runs_24h,
           count(*) filter (where r.status not in ('done','partial')) as failed_24h,
           coalesce(sum(r.items_processed),0)::bigint                 as items_24h
    from public.sync_runs r
    where r.organization_id = p_organization_id
      and r.finished_at >= now() - interval '24 hours'
    group by 1,2,3
  )
  select u.ml_account_id, a.label, u.resource, u.channel,
         u.last_run_at, u.last_run_status, u.last_run_reason,
         s.last_success_at, s.latest_record_at,
         coalesce(d.runs_24h,0), coalesce(d.failed_24h,0), coalesce(d.items_24h,0)
  from ultima u
  join public.ml_accounts a on a.id = u.ml_account_id
  left join sucesso s on (s.ml_account_id,s.resource,s.channel)=(u.ml_account_id,u.resource,u.channel)
  left join dia     d on (d.ml_account_id,d.resource,d.channel)=(u.ml_account_id,u.resource,u.channel)
  order by a.label, u.resource, u.channel
$$;

comment on function public.get_sync_health(uuid) is
  'Saude da sincronizacao por (conta, recurso, canal) -- D-143. Ultima execucao com status e motivo, ultimo SUCESSO, ultimo dado, e as contagens de 24h (execucoes, falhas, itens). Backfill e reconciliacao aparecem como canais separados, porque um e finito e o outro e permanente (PRD 2026-08-28). Nao inventa porcentagem: sem denominador confiavel, a tela mostra datas e contagens.';

revoke all on function public.get_sync_health(uuid) from public, anon;
grant execute on function public.get_sync_health(uuid) to authenticated, service_role;

create function public.get_processing_health(
  p_organization_id uuid
)
returns table (
  ml_account_id uuid,
  account_label text,
  latest_metric_date date,
  last_computed_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$
  -- O lado "processado por NOS" (PRD: distinguir dado puxado do ML de dado
  -- recalculado) -- e onde os gargalos aparecem: o ML pode estar em dia e o
  -- recalculo de metricas parado.
  select m.ml_account_id, a.label,
         max(m.metric_date)  as latest_metric_date,
         max(m.computed_at)  as last_computed_at
  from public.daily_account_metrics m
  join public.ml_accounts a on a.id = m.ml_account_id
  where m.organization_id = p_organization_id
  group by 1,2
  order by a.label
$$;

comment on function public.get_processing_health(uuid) is
  'O lado processado da sincronizacao (D-143): ate que dia as metricas diarias foram calculadas e quando foi o ultimo recalculo, por conta. Complementa get_sync_health -- o ML pode estar em dia e o recalculo parado.';

revoke all on function public.get_processing_health(uuid) from public, anon;
grant execute on function public.get_processing_health(uuid) to authenticated, service_role;
