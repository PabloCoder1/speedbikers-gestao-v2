-- ============================================================
-- D-435 -- as contas dos dois marketplaces numa fonte so, e a loja Shopee
-- parada avisa como a conta do Mercado Livre (etapa E3 da frente
-- multicanal, riscos R4 e R5 de docs/MULTICHANNEL_CONTRACTS.md).
--
-- 1. `marketplace_accounts` (C-52): uma linha por conta ML e por loja
--    Shopee que o chamador alcanca, com marketplace, nome, slug (ML) ou
--    shop_id (Shopee), ambiente, conexao, frescor dos pedidos e o
--    vencimento da autorizacao. E a fonte do seletor Marketplace/Conta das
--    telas (Agente 2): uma consulta, a permissao de D-175/D-433 aplicada
--    pelo banco.
--
-- 2. O FRESCOR DOS PEDIDOS DA LOJA NO RELOGIO DA PAREDE. O marco
--    `orders_synced_until` e o ponto ate onde a leitura chegou, no relogio da
--    Shopee: durante o historico de 90 dias ele fica semanas para tras com a
--    leitura funcionando -- um vigia que olhasse para ele avisaria "parada"
--    no meio da primeira leitura. `orders_last_success_at` e QUANDO o marco
--    andou pela ultima vez, gravado por gatilho: vale para o worker de hoje
--    (UPDATE direto) e para o de D-432 (`shopee_advance_orders_synced_until`).
--
-- 3. O AVISO DA LOJA E DA LOJA. `domain_events` ganha `shopee_shop_id`. Sem
--    ela, evento de loja seria evento sem conta -- e esse vai para TODOS os
--    membros (fan-out de D-073) e e visivel a todos (RLS), furando a
--    permissao por loja de D-433. Agora: evento com loja vai para quem a
--    alcanca (ADMIN e as concessoes), e so eles o leem.
--
-- 4. O VIGIA E O GATILHO DE D-417/D-418, PARA A LOJA. `sync.delayed` com 3 h
--    sem pedidos lidos, `sync.failed` com 12 h, e `sync.failed` na hora em
--    que a loja entra em ERROR -- as mesmas regras, chaves de episodio
--    proprias, o mesmo `vigiar_sincronizacao()` (o mesmo pg_cron). So loja
--    `live`: a de sandbox nao e operacao, e depois do Go Live o worker nem a
--    le (outro ambiente), entao avisaria para sempre.
--
-- O AGENDAMENTO CONTINUA SENDO O ATO DE D-418 (`select
-- private.agendar_vigia_da_sincronizacao();`) -- e em 14/10 ele AINDA NAO foi
-- feito em producao (`cron.job` vazio): nem a conta ML parada avisa hoje.
-- ============================================================

-- ------------------------------------------------------------
-- 2. O frescor dos pedidos da loja.
-- ------------------------------------------------------------
alter table public.shopee_shops add column if not exists orders_last_success_at timestamptz;

comment on column public.shopee_shops.orders_last_success_at is
  'Quando o marco da leitura de pedidos andou pela ultima vez, no relogio da parede (D-435): o frescor da sincronizacao, que o marco (relogio da Shopee, semanas atras durante o historico) nao mede. NULO = nunca andou.';

-- O que ja foi lido: o marco foi gravado como "agora" da execucao, entao e
-- a melhor aproximacao de quando ela terminou.
update public.shopee_shops
   set orders_last_success_at = orders_synced_until
 where orders_synced_until is not null
   and orders_last_success_at is null;

create or replace function private.shopee_marco_de_pedidos_andou()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.orders_synced_until is not null and new.orders_synced_until is distinct from old.orders_synced_until then
    new.orders_last_success_at := now();
  end if;

  return new;
end;
$$;

revoke all on function private.shopee_marco_de_pedidos_andou() from public, anon, authenticated;

create trigger shopee_shops_marco_de_pedidos
  before update of orders_synced_until on public.shopee_shops
  for each row execute function private.shopee_marco_de_pedidos_andou();

-- ------------------------------------------------------------
-- 3. O evento da loja: quem recebe e quem le.
-- ------------------------------------------------------------
-- Sem FK, como `organization_access_events.shopee_shop_id` (D-433): o
-- evento e append-only e sobrevive a loja.
alter table public.domain_events add column if not exists shopee_shop_id uuid;

comment on column public.domain_events.shopee_shop_id is
  'A loja Shopee do evento (D-435), como ml_account_id para a conta ML: o fan-out entrega e a RLS mostra so a quem alcanca a loja. Sem FK: o evento sobrevive a loja.';

-- Uma origem so. NOT VALID: a tabela e grande, e toda linha antiga tem a
-- loja nula -- a regra vale para o que entra daqui em diante sem varrer o
-- historico com a tabela travada.
alter table public.domain_events
  add constraint domain_events_uma_origem check (ml_account_id is null or shopee_shop_id is null) not valid;

drop policy domain_events_select_permitted on public.domain_events;
create policy domain_events_select_permitted
  on public.domain_events for select to authenticated
  using (
    (ml_account_id is not null and ml_account_id in (select private.accessible_accounts()))
    or (shopee_shop_id is not null and shopee_shop_id in (select private.accessible_shopee_shops()))
    or (ml_account_id is null and shopee_shop_id is null and organization_id in (select private.accessible_orgs()))
  );

-- O fan-out de D-073 (corpo vigente, de 20260916180200) com a loja.
create or replace function private.fan_out_notification()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_notification_id uuid;
begin
  if new.source = 'backfill' then
    return new;
  end if;

  insert into public.notifications (organization_id, domain_event_id)
  values (new.organization_id, new.id)
  returning id into v_notification_id;

  insert into public.notification_recipients (notification_id, user_id)
  select v_notification_id, m.user_id
  from public.organization_members m
  where m.organization_id = new.organization_id
    and (
      (new.ml_account_id is null and new.shopee_shop_id is null)
      or m.role = 'ADMIN'
      or (
        new.ml_account_id is not null
        and exists (
          select 1
          from public.user_account_permissions p
          where p.ml_account_id = new.ml_account_id
            and p.user_id = m.user_id
        )
      )
      or (
        new.shopee_shop_id is not null
        and exists (
          select 1
          from public.user_shopee_shop_permissions p
          where p.shopee_shop_id = new.shopee_shop_id
            and p.user_id = m.user_id
        )
      )
    );

  return new;
end;
$$;

-- ------------------------------------------------------------
-- 4. A loja parada avisa: a regra, o gatilho do ERROR e o vigia.
-- ------------------------------------------------------------
-- A regra de D-417 para a loja: o ultimo avanco do marco de pedidos (sem
-- nenhum, `connected_at`) contra `p_ate`. So loja live e CONNECTED. Devolve
-- se avisou.
create or replace function private.avisar_loja_shopee_parada(p_loja uuid, p_ate timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loja public.shopee_shops;
  v_referencia timestamptz;
  v_horas numeric;
  v_evento text;
  v_avisou boolean;
begin
  select * into v_loja from public.shopee_shops s where s.id = p_loja;

  if not found or v_loja.environment <> 'live' or v_loja.status <> 'CONNECTED' then
    return false;
  end if;

  v_referencia := coalesce(v_loja.orders_last_success_at, v_loja.connected_at);
  v_horas := extract(epoch from (p_ate - v_referencia)) / 3600;

  if v_horas < 3 then
    return false;
  end if;

  v_evento := case when v_horas >= 12 then 'sync.failed' else 'sync.delayed' end;

  insert into public.domain_events (
    organization_id, shopee_shop_id, occurred_at, event_type, entity_type, entity_id,
    before, after, severity, source, dedup_key)
  values (
    v_loja.organization_id, p_loja, now(), v_evento, 'shopee_shop', p_loja::text,
    null,
    jsonb_build_object(
      'tipo', 'reconciliacao',
      'marketplace', 'SHOPEE',
      'label', coalesce(v_loja.shop_name, 'Loja Shopee ' || v_loja.shop_id::text),
      'ultimo_sucesso', v_loja.orders_last_success_at,
      'horas', floor(v_horas),
      'motivo', 'Nenhuma leitura de pedidos da loja terminou desde o último sucesso.'),
    case when v_horas >= 12 then 'critico' else 'importante' end,
    'system',
    v_evento || ':shopee:' || p_loja::text || ':janela:' || to_char(v_referencia at time zone 'UTC', 'YYYYMMDDHH24MISSUS'))
  on conflict (dedup_key) do nothing
  returning true into v_avisou;

  return coalesce(v_avisou, false);
end;
$$;

-- A loja que entra em ERROR (recusa definitiva da renovacao, D-426) avisa
-- na hora, critico: sem reautorizar, nada mais sincroniza.
create or replace function private.aviso_de_loja_shopee_em_erro()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.domain_events (
    organization_id, shopee_shop_id, occurred_at, event_type, entity_type, entity_id,
    before, after, severity, source, dedup_key)
  values (
    new.organization_id, new.id, now(), 'sync.failed', 'shopee_shop', new.id::text,
    jsonb_build_object('status', old.status),
    jsonb_build_object(
      'tipo', 'conta_em_erro',
      'marketplace', 'SHOPEE',
      'label', coalesce(new.shop_name, 'Loja Shopee ' || new.shop_id::text),
      'motivo', left(new.last_error, 300)),
    'critico', 'system',
    'sync.failed:shopee:' || new.id::text || ':conta:' || to_char(new.updated_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'))
  on conflict (dedup_key) do nothing;

  return null;
end;
$$;

create trigger shopee_shops_aviso_de_erro
  after update of status on public.shopee_shops
  for each row
  when (new.status = 'ERROR' and old.status is distinct from 'ERROR' and new.environment = 'live')
  execute function private.aviso_de_loja_shopee_em_erro();

-- O vigia de D-418, com as lojas. A parte do ML e a mesma, linha a linha.
create or replace function private.vigiar_sincronizacao()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conta uuid;
  v_loja uuid;
  v_avisos integer := 0;
begin
  for v_conta in
    select a.id from public.ml_accounts a where a.status = 'CONNECTED'
  loop
    if private.avisar_sincronizacao_parada(v_conta, now(), null) then
      v_avisos := v_avisos + 1;
    end if;
  end loop;

  for v_loja in
    select s.id from public.shopee_shops s where s.status = 'CONNECTED' and s.environment = 'live'
  loop
    if private.avisar_loja_shopee_parada(v_loja, now()) then
      v_avisos := v_avisos + 1;
    end if;
  end loop;

  return v_avisos;
end;
$$;

revoke all on function private.avisar_loja_shopee_parada(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.aviso_de_loja_shopee_em_erro() from public, anon, authenticated, service_role;
revoke all on function private.vigiar_sincronizacao() from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 1. As contas dos dois marketplaces (C-52).
-- ------------------------------------------------------------
create view public.marketplace_accounts
with (security_invoker = true)
as
select
  'ML'::text as marketplace,
  a.id as account_id,
  a.organization_id,
  a.label as name,
  a.slug,
  null::bigint as shop_id,
  'live'::text as environment,
  a.status as connection_status,
  a.last_error,
  a.connected_at,
  -- O mesmo "ultimo sucesso" do vigia (D-418): a reconciliacao de pedidos.
  (
    select max(r.finished_at)
    from public.sync_runs r
    where r.ml_account_id = a.id
      and r.resource = 'orders'
      and r.channel = 'reconciliation'
      and r.status in ('done', 'partial')
  ) as orders_synced_at,
  -- O token do ML renova sem prazo de autorizacao.
  null::timestamptz as authorization_expires_at
from public.ml_accounts a

union all

select
  'SHOPEE'::text,
  s.id,
  s.organization_id,
  coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text),
  null::text,
  s.shop_id,
  s.environment,
  s.status,
  s.last_error,
  s.connected_at,
  s.orders_last_success_at,
  s.auth_expires_at
from public.shopee_shops s;

comment on view public.marketplace_accounts is
  'As contas ML e as lojas Shopee que o chamador alcanca (D-435, C-52), com marketplace (ML | SHOPEE), nome, slug (ML), shop_id (Shopee), ambiente (o ML e sempre live), conexao (ML: PENDING|CONNECTED|REVOKED|ERROR; Shopee: CONNECTED|ERROR), ultimo erro, frescor dos pedidos (ML: ultima reconciliacao de pedidos que serviu; Shopee: ultimo avanco do marco) e o vencimento da autorizacao (so Shopee). security_invoker: valem D-175 e D-433.';

revoke all on public.marketplace_accounts from anon, authenticated;
grant select on public.marketplace_accounts to authenticated;
grant select on public.marketplace_accounts to service_role;
