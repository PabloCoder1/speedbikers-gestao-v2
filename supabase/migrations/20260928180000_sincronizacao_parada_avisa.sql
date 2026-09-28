-- D-417 — A conta que para de sincronizar avisa.
--
-- Em 27/09/2026 as quatro contas ficaram ~32 horas sem sincronizar e ninguém
-- soube (D-414): a conta em ERROR faz todo job terminar como concluído sem
-- processar nada, e a reconciliação que falha grava `sync_runs` que ninguém
-- lê. `sync.delayed` e `sync.failed` estavam no catálogo desde o começo
-- (docs/API.md) e nada os emitia.
--
-- Dois gatilhos, e o fan-out de D-073 faz o resto -- notificação para quem
-- alcança a conta, toast, a família "Sincronização" da Central (D-393):
--
-- 1. A conta entra em ERROR -> `sync.failed` (crítico), na hora. É o que o
--    worker faz quando a troca de token é recusada de vez (D-414) e o que a
--    api faz quando a conexão falha: sem reconectar, nada mais sincroniza.
-- 2. A reconciliação horária de pedidos falha e o último sucesso tem mais de
--    3 horas -> `sync.delayed` (importante); mais de 12 horas -> `sync.failed`
--    (crítico). Os limiares são os de `classifySyncFreshness` da tela
--    /sincronizacao. É o que pega o bloqueio que não derruba a conta: a
--    renovação passageira de D-414 falha hora após hora com a conta CONNECTED.
--
-- UM AVISO POR EPISÓDIO. O `dedup_key` leva o último sucesso (ou a entrada em
-- ERROR): a falha seguinte do mesmo episódio não repete o aviso, e o próximo
-- sucesso começa outro.

create or replace function private.aviso_de_conta_em_erro()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.domain_events (
    organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id,
    before, after, severity, source, dedup_key)
  values (
    new.organization_id, new.id, now(), 'sync.failed', 'ml_account', new.id::text,
    jsonb_build_object('status', old.status),
    jsonb_build_object(
      'tipo', 'conta_em_erro',
      'label', new.label,
      'motivo', left(new.last_error, 300)),
    'critico', 'system',
    'sync.failed:' || new.id::text || ':conta:' || to_char(new.updated_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'))
  on conflict (dedup_key) do nothing;

  return null;
end;
$$;

create or replace function private.aviso_de_reconciliacao_parada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ultimo timestamptz;
  v_referencia timestamptz;
  v_label text;
  v_horas numeric;
  v_evento text;
begin
  -- O último sucesso da reconciliação de pedidos desta conta -- a linha que
  -- acabou de entrar é a falha, e não conta.
  select max(s.finished_at) into v_ultimo
  from public.sync_runs s
  where s.ml_account_id = new.ml_account_id
    and s.resource = 'orders'
    and s.channel = 'reconciliation'
    and s.status in ('done', 'partial');

  select a.label, coalesce(v_ultimo, a.connected_at) into v_label, v_referencia
  from public.ml_accounts a
  where a.id = new.ml_account_id;

  if v_referencia is null then
    return null;
  end if;

  v_horas := extract(epoch from (new.finished_at - v_referencia)) / 3600;

  if v_horas < 3 then
    return null;
  end if;

  v_evento := case when v_horas >= 12 then 'sync.failed' else 'sync.delayed' end;

  insert into public.domain_events (
    organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id,
    before, after, severity, source, dedup_key)
  values (
    new.organization_id, new.ml_account_id, now(), v_evento, 'ml_account', new.ml_account_id::text,
    null,
    jsonb_build_object(
      'tipo', 'reconciliacao',
      'label', v_label,
      'ultimo_sucesso', v_ultimo,
      'horas', floor(v_horas),
      'motivo', left(new.reason, 300)),
    case when v_horas >= 12 then 'critico' else 'importante' end,
    'system',
    v_evento || ':' || new.ml_account_id::text || ':janela:' || to_char(v_referencia at time zone 'UTC', 'YYYYMMDDHH24MISSUS'))
  on conflict (dedup_key) do nothing;

  return null;
end;
$$;

-- Nada disto é chamável de fora: só os gatilhos.
revoke all on function private.aviso_de_conta_em_erro() from public, anon, authenticated, service_role;
revoke all on function private.aviso_de_reconciliacao_parada() from public, anon, authenticated, service_role;

create trigger ml_accounts_aviso_de_erro
  after update of status on public.ml_accounts
  for each row
  when (new.status = 'ERROR' and old.status is distinct from 'ERROR')
  execute function private.aviso_de_conta_em_erro();

create trigger sync_runs_aviso_de_parada
  after insert on public.sync_runs
  for each row
  when (new.status = 'failed' and new.resource = 'orders' and new.channel = 'reconciliation')
  execute function private.aviso_de_reconciliacao_parada();
