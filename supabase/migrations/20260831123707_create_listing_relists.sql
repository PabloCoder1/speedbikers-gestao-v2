-- ============================================================
-- Modelo pai→filho da republicação oficial (Fase 9, D-159).
--
-- `docs/MERCADO_LIVRE.md` secao 2.16: o fluxo real fecha o pai
-- (IRREVERSÍVEL) antes do POST /relist, e a API NÃO oferece idempotência
-- nenhuma — a proteção contra fechar sem criar o filho, ou criar dois
-- filhos, é 100% nossa. Aqui ela vira CONSTRAINT, não boa vontade:
--
-- 1. `listing_relists_one_live_per_parent`: uma operação viva/concluída por
--    pai. O predicado (PREFLIGHT_FAILED/CLOSE_FAILED reabrem; o resto trava)
--    espelha RELIST_REOPENABLE_STATES em @sb/domain/listings — mudar um
--    exige mudar o outro, e o teste de integração fixa a equivalência.
-- 2. `listing_relists_child_unique`: um filho nunca pertence a duas
--    operações.
-- 3. CHECK de coerência: child_item_id só existe a partir de RELISTED.
--
-- A VALIDAÇÃO DE TRANSIÇÃO fica no domínio (canTransitionRelist), única
-- implementação — duplicá-la em trigger SQL exigiria teste de equivalência
-- sem ganho: quem escreve aqui é só o worker/service_role (e a RPC humana
-- futura), sempre passando pela máquina de estados. O banco garante o que
-- código nenhum pode furar: unicidade e coerência estrutural.
--
-- FKs por lição registrada: ator RESTRICT (D-099 — SET NULL + auditoria é
-- contradição), histórico RESTRICT (D-149 — cascade + append-only quebra o
-- teardown com os testes verdes).
-- ============================================================

create table public.listing_relists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,

  parent_item_id text not null check (parent_item_id ~ '^MLB[0-9]+$'),
  -- Preenchido SÓ quando o filho é confirmado no remoto (com parent_item_id
  -- apontando de volta) — nunca pelo que o POST "deveria" ter criado.
  child_item_id text check (child_item_id ~ '^MLB[0-9]+$'),

  status text not null default 'REQUESTED'
    check (status in (
      'REQUESTED', 'PREFLIGHT_FAILED', 'CLOSING', 'CLOSED', 'CLOSE_FAILED',
      'RELISTING', 'RELISTED', 'RELIST_FAILED', 'REMAPPED'
    )),

  -- Snapshot AUDITÁVEL do pai no momento do pedido (PRD: base do preflight,
  -- do remapeamento e da comparação antes/depois). Capturado na criação,
  -- nunca sobrescrito.
  parent_snapshot jsonb not null,

  failure_reason text,
  requested_by uuid not null references public.profiles(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Filho sem estado que o justifique é mentira estrutural.
  constraint listing_relists_child_requires_state
    check (child_item_id is null or status in ('RELISTED', 'REMAPPED'))
);

comment on table public.listing_relists is
  'Operação de republicação (Fase 9, D-159): pai→filho rastreável por estados, com idempotência própria — a API do ML não oferece nenhuma (secao 2.16). Transições validadas por canTransitionRelist (@sb/domain/listings).';

create trigger listing_relists_set_updated_at
  before update on public.listing_relists
  for each row execute function private.set_updated_at();

-- Idempotência 1: uma operação viva (ou concluída) por pai. O predicado
-- espelha RELIST_REOPENABLE_STATES (@sb/domain/listings).
create unique index listing_relists_one_live_per_parent
  on public.listing_relists (ml_account_id, parent_item_id)
  where status not in ('PREFLIGHT_FAILED', 'CLOSE_FAILED');

-- Idempotência 2: um filho nunca pertence a duas operações.
create unique index listing_relists_child_unique
  on public.listing_relists (ml_account_id, child_item_id)
  where child_item_id is not null;

-- A Busca Universal e o Dashboard de Anúncios vão perguntar "este item tem
-- republicação?" pelos dois lados (PRD: relação preservada para sempre, nos
-- dois sentidos) — o índice do pai é o único parcial acima; o do filho idem.

create table public.listing_relist_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,
  relist_id uuid not null references public.listing_relists(id) on delete restrict,

  -- NULL = evento de criação (não existe estado anterior).
  from_status text
    check (from_status in (
      'REQUESTED', 'PREFLIGHT_FAILED', 'CLOSING', 'CLOSED', 'CLOSE_FAILED',
      'RELISTING', 'RELISTED', 'RELIST_FAILED', 'REMAPPED'
    )),
  to_status text not null
    check (to_status in (
      'REQUESTED', 'PREFLIGHT_FAILED', 'CLOSING', 'CLOSED', 'CLOSE_FAILED',
      'RELISTING', 'RELISTED', 'RELIST_FAILED', 'REMAPPED'
    )),

  -- Nulo nas transições do worker; preenchido nos atos humanos (pedido,
  -- retry autorizado). RESTRICT por D-099.
  actor_user_id uuid references public.profiles(id) on delete restrict,
  reason text,

  occurred_at timestamptz not null default now()
);

comment on table public.listing_relist_events is
  'Histórico append-only da operação de republicação — uma linha por transição, com ator quando o ato é humano.';

create index listing_relist_events_relist_idx
  on public.listing_relist_events (relist_id, occurred_at desc);

create or replace function public.listing_relist_events_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'listing_relist_events e append-only: % nao e permitido.', tg_op;
end;
$$;

create trigger listing_relist_events_no_update
  before update on public.listing_relist_events
  for each row execute function public.listing_relist_events_reject_mutation();

create trigger listing_relist_events_no_delete
  before delete on public.listing_relist_events
  for each row execute function public.listing_relist_events_reject_mutation();

-- RLS: leitura por acesso à conta (a operação pertence ao contexto da conta
-- ML, como support_cases). Escrita NÃO tem policy para authenticated — vem
-- do worker/service_role e, na fatia futura, de RPC com checagem própria.
alter table public.listing_relists enable row level security;
alter table public.listing_relist_events enable row level security;

create policy listing_relists_select_permitted
  on public.listing_relists for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy listing_relist_events_select_permitted
  on public.listing_relist_events for select to authenticated
  using (private.has_account_access(ml_account_id));

-- Grants explícitos (lição D-062/D-066: o default concede escrita demais).
revoke all on public.listing_relists from anon, authenticated, service_role;
revoke all on public.listing_relist_events from anon, authenticated, service_role;

grant select on public.listing_relists to authenticated;
grant select on public.listing_relist_events to authenticated;

grant select, insert, update on public.listing_relists to service_role;
-- Sem update/delete nem para service_role: append-only de verdade (os
-- triggers rejeitariam de qualquer forma; o grant nem abre a porta).
grant select, insert on public.listing_relist_events to service_role;
