-- D-418 — O banco vigia a sincronização.
--
-- D-417 avisa quando a reconciliação de pedidos FALHA há horas. Não avisa
-- quando ela para de RODAR: se o agendador deixa de enfileirar (D-217, "um
-- job que para de ser enfileirado não falha -- emudece"), nenhuma linha de
-- `sync_runs` entra, e o gatilho não tem o que ver. O Cloud Scheduler fica
-- verde, o endpoint responde 200, e nada acontece.
--
-- O vigia roda DENTRO do banco (pg_cron), sem depender do Cloud Scheduler, da
-- api nem do worker: para cada conta CONNECTED, a idade do último sucesso da
-- reconciliação de pedidos -- 3 horas avisa `sync.delayed`, 12 avisa
-- `sync.failed`. Mesma regra e MESMA chave de episódio do gatilho de D-417
-- (uma função só, abaixo): o vigia e o gatilho nunca avisam duas vezes o mesmo
-- episódio. A conta em ERROR fica de fora -- o gatilho dela já avisou.
--
-- O AGENDAMENTO É UM ATO, NÃO A MIGRATION. Agendado aqui, o vigia rodaria
-- também no banco de teste da CI e no local, e um aviso numa conta de teste
-- (a limpeza apaga as contas `rlstest`, e o evento as prende com `on delete
-- restrict`) quebraria a suíte ao acaso. Em produção, depois da migration:
--
--   select private.agendar_vigia_da_sincronizacao();

create extension if not exists pg_cron with schema pg_catalog;

-- A regra do aviso, num lugar só: o último sucesso da reconciliação de pedidos
-- da conta (sem nenhum, `connected_at`) contra `p_ate`. Devolve se avisou.
create or replace function private.avisar_sincronizacao_parada(
  p_conta uuid,
  p_ate timestamptz,
  p_motivo text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ultimo timestamptz;
  v_referencia timestamptz;
  v_label text;
  v_organizacao uuid;
  v_horas numeric;
  v_evento text;
  v_motivo text;
  v_avisou boolean;
begin
  select max(s.finished_at) into v_ultimo
  from public.sync_runs s
  where s.ml_account_id = p_conta
    and s.resource = 'orders'
    and s.channel = 'reconciliation'
    and s.status in ('done', 'partial');

  select a.label, a.organization_id, coalesce(v_ultimo, a.connected_at)
    into v_label, v_organizacao, v_referencia
  from public.ml_accounts a
  where a.id = p_conta;

  if v_referencia is null then
    return false;
  end if;

  v_horas := extract(epoch from (p_ate - v_referencia)) / 3600;

  if v_horas < 3 then
    return false;
  end if;

  -- Sem motivo dado (o vigia), o da última falha desde o último sucesso; sem
  -- falha nenhuma, a reconciliação simplesmente não rodou.
  v_motivo := coalesce(
    p_motivo,
    (select s.reason from public.sync_runs s
     where s.ml_account_id = p_conta and s.resource = 'orders' and s.channel = 'reconciliation'
       and s.status = 'failed' and s.finished_at > v_referencia
     order by s.finished_at desc limit 1),
    'Nenhuma reconciliação de pedidos rodou desde o último sucesso.');

  v_evento := case when v_horas >= 12 then 'sync.failed' else 'sync.delayed' end;

  insert into public.domain_events (
    organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id,
    before, after, severity, source, dedup_key)
  values (
    v_organizacao, p_conta, now(), v_evento, 'ml_account', p_conta::text,
    null,
    jsonb_build_object(
      'tipo', 'reconciliacao',
      'label', v_label,
      'ultimo_sucesso', v_ultimo,
      'horas', floor(v_horas),
      'motivo', left(v_motivo, 300)),
    case when v_horas >= 12 then 'critico' else 'importante' end,
    'system',
    v_evento || ':' || p_conta::text || ':janela:' || to_char(v_referencia at time zone 'UTC', 'YYYYMMDDHH24MISSUS'))
  on conflict (dedup_key) do nothing
  returning true into v_avisou;

  return coalesce(v_avisou, false);
end;
$$;

-- O gatilho de D-417 passa a usar a regra comum: mesmo aviso, mesma chave.
create or replace function private.aviso_de_reconciliacao_parada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.avisar_sincronizacao_parada(new.ml_account_id, new.finished_at, new.reason);

  return null;
end;
$$;

-- O vigia: toda conta conectada, contra agora. Devolve quantos avisos novos.
create or replace function private.vigiar_sincronizacao()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conta uuid;
  v_avisos integer := 0;
begin
  for v_conta in
    select a.id from public.ml_accounts a where a.status = 'CONNECTED'
  loop
    if private.avisar_sincronizacao_parada(v_conta, now(), null) then
      v_avisos := v_avisos + 1;
    end if;
  end loop;

  return v_avisos;
end;
$$;

-- O ato de produção: agenda o vigia a cada 30 minutos (o nome o torna
-- idempotente -- rodar de novo só reescreve o horário).
create or replace function private.agendar_vigia_da_sincronizacao()
returns bigint
language sql
security definer
set search_path = ''
as $$
  select cron.schedule('vigiar-sincronizacao', '*/30 * * * *', 'select private.vigiar_sincronizacao()');
$$;

revoke all on function private.avisar_sincronizacao_parada(uuid, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function private.vigiar_sincronizacao() from public, anon, authenticated, service_role;
revoke all on function private.agendar_vigia_da_sincronizacao() from public, anon, authenticated, service_role;
