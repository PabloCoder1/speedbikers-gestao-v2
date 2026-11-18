-- ============================================================
-- D-721: retenção de 30 dias para as execuções concluídas de `job_runs`
--
-- POR QUE AGORA, se a D-222 disse "limpeza única, não política de
-- retenção": a D-222 tratava a massa de um defeito morto (webhook sem
-- trabalho antes da D-179). O que o backup de produção de 22/10 mostrou é
-- FLUXO corrente: ~70 MB/mês em disco, e só `sync.webhook.received` com
-- `status = done` é ~60% das linhas de outubro. Sem retenção, `job_runs`
-- cresce sem teto; no Supabase Free (cota de 500 MB) seria a terceira maior
-- tabela em poucos meses (docs/database-migration/SIZE_REPORT.md).
--
-- O QUE SAI, e só isto:
--   * `status = 'done'`. Falha NUNCA sai: é o que se investiga, e
--     `get_job_failures` lê até 90 dias delas;
--   * `finished_at` há mais de 30 dias. Nenhum leitor olha execução
--     concluída mais velha: `get_system_health` lê a última de cada tipo e
--     as falhas de 24 h, `get_job_failures` só falhas, e
--     `get_erp_stock_cutoffs` a última `maintenance.reconcile-balances`
--     concluída da organização;
--   * MENOS a mais recente de cada (organização, tipo) que não rodou nos
--     últimos 30 dias. Ela é a "última execução" da Saúde do Sistema e o
--     `reconciled_at` do corte do UpSeller (D-351). Um tipo que parou de
--     rodar há 40 dias continua aparecendo com a data certa, e não como
--     "nunca rodou".
--
-- O APPEND-ONLY CONTINUA FÍSICO (D-221). O gatilho de DELETE recusa tudo,
-- exceto a linha que a própria regra de retenção deixaria sair (`done` e
-- vencida), e só quando a transação ligou `sb.expurgo_job_runs`. Quem
-- liga é o expurgo. Uma falha, uma linha recente ou um DELETE solto, até
-- pelo dono, continuam recusados. UPDATE segue recusado sempre. A proteção
-- da última de cada tipo é do expurgo, não do gatilho: o gatilho não sabe
-- o que é "a última" sem ler a tabela a cada linha.
--
-- LOTES: até 20 lotes de 5 mil por chamada. A primeira rodada em produção
-- tira o acúmulo de setembro e outubro; dali em diante, ~1 dia de linhas por
-- noite. Sem VACUUM FULL (lock exclusivo): o espaço volta ao uso pela
-- própria tabela, como na D-222.
--
-- O AGENDAMENTO É UM ATO, NÃO A MIGRATION (o padrão da D-418):
-- `select private.agendar_expurgo_de_telemetria();` em produção, depois do
-- deploy. Até lá, nada é apagado.
-- ============================================================

create or replace function private.job_runs_reject_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('sb.expurgo_job_runs', true) = 'on'
     and old.status = 'done'
     and old.finished_at < now() - interval '30 days' then
    return old;
  end if;

  raise exception
    'job_runs e append-only: % nao e permitido. Corrija inserindo uma nova linha.',
    tg_op;
end;
$$;

comment on function private.job_runs_reject_delete() is
  'Recusa DELETE em job_runs, exceto a linha done com mais de 30 dias quando a transacao ligou sb.expurgo_job_runs (o expurgo de D-721).';

revoke all on function private.job_runs_reject_delete() from public, anon, authenticated, service_role;

drop trigger if exists job_runs_no_delete on public.job_runs;

create trigger job_runs_no_delete
  before delete on public.job_runs
  for each row execute function private.job_runs_reject_delete();

create or replace function private.expurgar_job_runs(
  p_lote integer default 5000,
  p_max_lotes integer default 20
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limite constant timestamptz := now() - interval '30 days';
  v_lote constant integer := least(greatest(coalesce(p_lote, 5000), 1), 50000);
  v_max_lotes constant integer := least(greatest(coalesce(p_max_lotes, 20), 1), 200);
  v_protegidos uuid[];
  v_apagadas integer;
  v_total integer := 0;
begin
  -- O (organização, tipo) sem nenhuma execução nos últimos 30 dias guarda a
  -- sua concluída mais nova: ela é a "última execução" que a Saúde do
  -- Sistema e o corte do UpSeller leem. Quem rodou dentro da janela já tem
  -- a última dentro dela. Dezenas de linhas, lidas uma vez por chamada.
  select coalesce(array_agg(u.id), '{}')
    into v_protegidos
  from (
    select distinct on (r.organization_id, r.job_type) r.id, r.organization_id, r.job_type
    from public.job_runs r
    where r.status = 'done'
      and r.finished_at < v_limite
    order by r.organization_id, r.job_type, r.finished_at desc
  ) u
  where not exists (
    select 1
    from public.job_runs n
    where n.job_type = u.job_type
      and n.organization_id = u.organization_id
      and coalesce(n.finished_at, n.started_at) >= v_limite
  );

  perform set_config('sb.expurgo_job_runs', 'on', true);

  for i in 1..v_max_lotes loop
    delete from public.job_runs j
    where j.id in (
      select r.id
      from public.job_runs r
      where r.status = 'done'
        and r.finished_at < v_limite
        and r.id <> all (v_protegidos)
      limit v_lote
    );

    get diagnostics v_apagadas = row_count;
    v_total := v_total + v_apagadas;
    exit when v_apagadas < v_lote;
  end loop;

  perform set_config('sb.expurgo_job_runs', 'off', true);

  return v_total;
end;
$$;

comment on function private.expurgar_job_runs(integer, integer) is
  'Retencao de job_runs (D-721): apaga execucoes done com mais de 30 dias, menos a mais recente de cada (organizacao, tipo); falha nunca sai. Ate p_max_lotes lotes de p_lote linhas. Devolve quantas saíram.';

create or replace function private.agendar_expurgo_de_telemetria()
returns bigint
language sql
security definer
set search_path = ''
as $$
  -- 06:30 UTC = 03:30 em Brasília, fora do horário de venda e antes da
  -- conciliação das 06:00 (BRT). O nome torna o agendamento idempotente.
  select cron.schedule('expurgar-telemetria', '30 6 * * *', 'select private.expurgar_job_runs()');
$$;

revoke all on function private.expurgar_job_runs(integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.agendar_expurgo_de_telemetria() from public, anon, authenticated, service_role;
