-- ============================================================
-- Notificações (Fase 7, item 3 da sequência de `docs/HANDOFF.md`):
-- persistência + regra de destinatário. Fecha "notification_preferences
-- entra no schema desde a Fase 2, mesmo que a interface só apareça na
-- Fase 7" (docs/NOTIFICATIONS.md secao 6) — atrasado até agora, corrigido
-- aqui.
--
-- Cadeia completa (docs/NOTIFICATIONS.md secao 1):
--   domain_events -> regra de severidade (já em @sb/domain/events,
--   gravada na própria linha) -> regra de destinatário (aqui) ->
--   notifications + notification_recipients -> Realtime -> toast/Central.
--
-- Realtime, toasts, Central de Notificações (UI) e a interface de
-- preferências são etapas SEPARADAS e posteriores (docs/HANDOFF.md,
-- itens 4/5/6) — esta migration só fecha persistência + regra.
--
-- Deliberadamente SEM backfill: domain_events já tem linhas reais desde a
-- Fase 3 (order.cancelled, stock.depleted/replenished, etc.). Sem UI para
-- consumir Central de Notificações ainda, backfilar histórico não tem
-- benefício visível hoje e arrisca uma migration pesada contra tabela de
-- produção real. A partir desta migration, todo domain_event NOVO gera
-- notificação; histórico anterior fica só em domain_events.
-- ============================================================

-- ============================================================
-- 1. notifications — uma por domain_event
-- ============================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Uma notificação por evento, nunca duas — o fan-out (secao 4) grava
  -- exatamente uma vez por domain_event, o UNIQUE é a garantia física.
  domain_event_id uuid not null unique references public.domain_events(id) on delete cascade,

  created_at timestamptz not null default now()
);

comment on table public.notifications is
  'Uma linha por domain_event notificável (docs/NOTIFICATIONS.md). Detalhe do evento (event_type, before/after, severity) fica em domain_events — join por domain_event_id, sem duplicar.';

create index notifications_org_created_idx
  on public.notifications (organization_id, created_at desc);

-- ============================================================
-- 2. notification_recipients — quem recebe, lido/não lido
-- ============================================================

create table public.notification_recipients (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,

  -- NULL = não lida. Mesma convenção de connected_at/resolved_at no resto
  -- do schema — estado por data, não um boolean separado.
  read_at timestamptz,

  created_at timestamptz not null default now(),

  primary key (notification_id, user_id)
);

comment on table public.notification_recipients is
  'Fan-out por usuário de uma notification. read_at nulo = não lida.';

create index notification_recipients_user_unread_idx
  on public.notification_recipients (user_id, created_at desc)
  where read_at is null;

-- ============================================================
-- 3. notification_preferences — granularidade por usuário, event_type,
--    conta e severidade mínima (docs/NOTIFICATIONS.md secao 6)
--
-- Sem UI para criar linhas ainda (Fase 7, item 6, posterior) — a tabela
-- nasce vazia, e o fan-out (secao 4) trata "sem preferência" como
-- "notificar" por padrão. `event_type`/`ml_account_id` nulos são
-- curingas ("aplica a todos"); a linha mais específica vence quando mais
-- de uma casa.
--
-- Mesma pegadinha já documentada para sku_listing_links (docs/DATABASE.md
-- secao 4): NULL não colide em UNIQUE simples, por isso os quatro índices
-- únicos parciais abaixo, um por combinação de curinga.
-- ============================================================

create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  -- NULL = aplica a qualquer event_type sem linha mais específica.
  event_type text check (event_type is null or char_length(event_type) between 1 and 100),

  -- NULL = aplica a qualquer conta (inclusive eventos organizacionais).
  ml_account_id uuid references public.ml_accounts(id) on delete cascade,

  min_severity text not null default 'informativo'
    check (min_severity in ('informativo', 'importante', 'critico')),

  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.notification_preferences is
  'Granularidade por usuário/event_type/conta/severidade mínima. Vazia até a Fase 7 item 6 (UI) existir — fan-out trata ausência como "notificar".';

create unique index notification_preferences_unique_both_null
  on public.notification_preferences (user_id)
  where event_type is null and ml_account_id is null;

create unique index notification_preferences_unique_event_only
  on public.notification_preferences (user_id, event_type)
  where event_type is not null and ml_account_id is null;

create unique index notification_preferences_unique_account_only
  on public.notification_preferences (user_id, ml_account_id)
  where event_type is null and ml_account_id is not null;

create unique index notification_preferences_unique_event_and_account
  on public.notification_preferences (user_id, event_type, ml_account_id)
  where event_type is not null and ml_account_id is not null;

create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function private.set_updated_at();

-- ============================================================
-- 4. Fan-out: domain_events -> notifications + notification_recipients
--
-- AFTER INSERT em domain_events, não RPC nem código de aplicação — mesmo
-- raciocínio de private.apply_stock_movement (docs/DATABASE.md): toda
-- linha nova em domain_events, de QUALQUER chamador presente ou futuro
-- (persist-order.ts, claim-return.ts, ml-fulfillment-fetch.ts,
-- ml-listings-fetch.ts, e o que vier depois), fica coberta sem que cada
-- call site precise lembrar de notificar. Sem `security definer`, mesmo
-- padrão de apply_stock_movement — o worker já grava domain_events como
-- service_role, privilégio suficiente para as duas tabelas novas.
--
-- Destinatários (docs/NOTIFICATIONS.md secao 5, "permissão por conta"):
-- evento organizacional (ml_account_id nulo) alcança todo membro da
-- organização; evento de conta alcança ADMIN (sempre, mesmo raciocínio de
-- private.has_account_access) mais quem tiver user_account_permissions
-- para aquela conta especificamente. É a mesma regra de acesso já usada
-- para leitura de domain_events (D-054), só expressa como conjunto em vez
-- de checagem do usuário corrente.
--
-- Preferência aplicada por usuário: a linha mais específica vence
-- (event_type e ml_account_id batendo > só um batendo > nenhum, curinga
-- geral); enabled=false ou severidade abaixo do mínimo pedido suprime.
-- Sem linha nenhuma, notifica — default seguro enquanto não existir UI
-- para configurar.
-- ============================================================

create or replace function private.fan_out_notification()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_notification_id uuid;
begin
  insert into public.notifications (organization_id, domain_event_id)
  values (new.organization_id, new.id)
  returning id into v_notification_id;

  insert into public.notification_recipients (notification_id, user_id)
  select v_notification_id, candidate.user_id
  from (
    select m.user_id
    from public.organization_members m
    where m.organization_id = new.organization_id
      and (
        new.ml_account_id is null
        or m.role = 'ADMIN'
        or exists (
          select 1
          from public.user_account_permissions p
          where p.ml_account_id = new.ml_account_id
            and p.user_id = m.user_id
        )
      )
  ) as candidate
  where coalesce(
    (
      select pref.enabled
        and (
          case pref.min_severity
            when 'critico' then 3
            when 'importante' then 2
            else 1
          end
        ) <= (
          case new.severity
            when 'critico' then 3
            when 'importante' then 2
            else 1
          end
        )
      from public.notification_preferences pref
      where pref.user_id = candidate.user_id
        and (pref.event_type = new.event_type or pref.event_type is null)
        and (pref.ml_account_id = new.ml_account_id or pref.ml_account_id is null)
      order by
        (pref.event_type is not null)::int + (pref.ml_account_id is not null)::int desc
      limit 1
    ),
    true
  );

  return new;
end;
$$;

comment on function private.fan_out_notification is
  'AFTER INSERT em domain_events: cria notifications + notification_recipients respeitando permissão por conta e notification_preferences. docs/NOTIFICATIONS.md.';

create trigger domain_events_fan_out_notification
  after insert on public.domain_events
  for each row execute function private.fan_out_notification();

-- ============================================================
-- 5. RLS
-- ============================================================

alter table public.notifications enable row level security;
alter table public.notification_recipients enable row level security;
alter table public.notification_preferences enable row level security;

-- Leitura de notifications amarrada a ser destinatário de verdade — não
-- repete has_account_access aqui de propósito: notification_recipients já
-- encodou a regra de acesso no momento do fan-out, então checar "existe
-- uma linha minha" é suficiente e não duplica a lógica de permissão.
create policy notifications_select_via_recipient
  on public.notifications for select to authenticated
  using (
    exists (
      select 1
      from public.notification_recipients nr
      where nr.notification_id = notifications.id
        and nr.user_id = (select auth.uid())
    )
  );

create policy notification_recipients_select_own
  on public.notification_recipients for select to authenticated
  using (user_id = (select auth.uid()));

-- Marcar lida é a única escrita de usuário nesta tabela (ARCHITECTURE.md
-- secao 4: "Server Actions para escritas simples no escopo do usuário —
-- marcar notificação lida" é citado nominalmente como exemplo). Direto sob
-- RLS, sem RPC — mesmo nível de simplicidade de profiles_update_self.
create policy notification_recipients_update_own
  on public.notification_recipients for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy notification_preferences_select_own
  on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()));

-- Preferência é auto-gerenciada — mesmo raciocínio de profiles_update_self,
-- sem RPC: não há segredo nem lógica de autorização cruzada envolvida.
create policy notification_preferences_all_own
  on public.notification_preferences for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ============================================================
-- 6. GRANTs
--
-- `authenticated` só SELECT em notifications (a escrita é sempre pelo
-- trigger, via service_role da própria inserção em domain_events).
-- `notification_recipients` ganha UPDATE para a Server Action de marcar
-- lida. `notification_preferences` ganha o CRUD completo — é
-- autoatendido pelo próprio usuário, mesmo padrão de saved_filters.
-- ============================================================

grant select on public.notifications to authenticated;
grant select, update on public.notification_recipients to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;

grant select, insert, update, delete
  on public.notifications, public.notification_recipients, public.notification_preferences
  to service_role;

revoke all on public.notifications from anon;
revoke all on public.notification_recipients from anon;
revoke all on public.notification_preferences from anon;
