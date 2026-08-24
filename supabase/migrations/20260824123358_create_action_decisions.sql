-- Memória de decisões operacionais (Fase 6, terceiro e último item do
-- checklist — `docs/PROMPT_MASTER.md` secao 29, `docs/ARCHITECTURE.md`
-- secao 16, `docs/DATABASE.md` secao "actions"). Fecha o Marco da Fase 6:
-- "o sistema responde 'por quê', com evidência e nível de confiança" —
-- esta peça fecha o ciclo aprendendo se a decisão tomada funcionou.
--
-- Duas tabelas, já desenhadas desde D-064: `action_decisions` (a decisão em
-- si, com `baseline_snapshot` capturado NO MOMENTO — sem ele, comparar
-- depois é impossível) e `action_outcomes` (resultado medido 7/15/30 dias
-- depois, preenchido por job agendado). Objetivo do produto: aprender quais
-- ações realmente funcionam para a operação, não só registrar burocracia.

create table public.action_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null references public.actions(id) on delete cascade,

  decision text not null,
  baseline_snapshot jsonb not null,

  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

comment on table public.action_decisions is
  'Memória de decisões operacionais (Fase 6, PROMPT_MASTER secao 29) — decisão registrada a partir de uma ação, com baseline_snapshot capturado no momento (get_sku_decision_snapshot). Escrita só via create_action_decision (security definer); action_outcomes mede o resultado depois.';

create index action_decisions_action_id_idx on public.action_decisions (action_id);
create index action_decisions_org_created_at_idx on public.action_decisions (organization_id, created_at);

alter table public.action_decisions enable row level security;

create policy action_decisions_select_own_org
  on public.action_decisions for select
  to authenticated
  using (private.is_member_of(organization_id));

-- Mesmo achado de D-062/D-064: GRANT precisa ser revogado de `authenticated`
-- explicitamente, não só de `anon` — privilégio padrão deste projeto
-- Supabase concede INSERT/UPDATE/DELETE em tabela nova por padrão.
revoke all on public.action_decisions from anon, authenticated;
grant select on public.action_decisions to authenticated;
grant all on public.action_decisions to service_role;

-- `action_outcomes` é escrita só pelo worker (job agendado), mesmo padrão de
-- `actions`: sem RPC, o worker já é confiável (autorização é "esta
-- organização existe", não "este usuário tem permissão"). `organization_id`
-- desnormalizado (alcançável via action_decisions -> actions) para RLS
-- direta, sem join — mesmo raciocínio de performance de `docs/DATABASE.md`
-- secao 5 (RLS entra no plano de toda consulta).
create table public.action_outcomes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action_decision_id uuid not null references public.action_decisions(id) on delete cascade,

  window_days integer not null check (window_days in (7, 15, 30)),
  outcome_snapshot jsonb not null,

  measured_at timestamptz not null default now(),

  unique (action_decision_id, window_days)
);

comment on table public.action_outcomes is
  'Resultado medido 7/15/30 dias depois de uma decisão (Fase 6) — mesma forma de baseline_snapshot (get_sku_decision_snapshot), permite comparação bruta lado a lado, nunca uma % sintetizada (mesmo raciocínio de /vendas). Gravado pelo job diagnostics.measure-decision-outcomes, uma vez por janela — medição histórica fixa, nunca recalculada.';

create index action_outcomes_org_idx on public.action_outcomes (organization_id);

alter table public.action_outcomes enable row level security;

create policy action_outcomes_select_own_org
  on public.action_outcomes for select
  to authenticated
  using (private.is_member_of(organization_id));

revoke all on public.action_outcomes from anon, authenticated;
grant select on public.action_outcomes to authenticated;
grant all on public.action_outcomes to service_role;

-- Snapshot do estado de um SKU numa data — mesma função usada tanto para o
-- baseline (no momento da decisão) quanto para cada outcome (7/15/30 dias
-- depois): só muda o `p_as_of`. `security invoker`, só agrega em SQL
-- (`docs/ARCHITECTURE.md` secao 21). `avg_price_7d` é receita/unidades no
-- período (preço médio PONDERADO, não média de médias diárias) — mesmo
-- raciocínio já usado em `average_selling_price` gerada.
create function public.get_sku_decision_snapshot(
  p_organization_id uuid,
  p_sku_id uuid,
  p_as_of date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'as_of', p_as_of,
    'units_sold_7d', coalesce(m.units_sold_7d, 0),
    'avg_daily_units_7d', round(coalesce(m.units_sold_7d, 0) / 7.0, 2),
    'avg_price_7d', round(m.gross_revenue_7d / nullif(m.units_sold_7d, 0), 2),
    'stock_local', coalesce(b.quantity, 0)
  )
  from (
    select
      sum(dsm.units_sold) as units_sold_7d,
      sum(dsm.gross_revenue) as gross_revenue_7d
    from public.daily_sku_metrics dsm
    where dsm.organization_id = p_organization_id
      and dsm.sku_id = p_sku_id
      and dsm.metric_date between (p_as_of - 6) and p_as_of
  ) m
  left join public.inventory_balances b
    on b.sku_id = p_sku_id and b.location_kind = 'LOCAL'
$$;

comment on function public.get_sku_decision_snapshot(uuid, uuid, date) is
  'Snapshot do estado de um SKU (venda de 7 dias + estoque local atual) numa data — usado tanto pra baseline_snapshot (create_action_decision) quanto pra outcome_snapshot (job diagnostics.measure-decision-outcomes), só muda o as_of.';

revoke all on function public.get_sku_decision_snapshot(uuid, uuid, date) from public, anon;
grant execute on function public.get_sku_decision_snapshot(uuid, uuid, date) to authenticated, service_role;

-- Único caminho de escrita em `action_decisions` pelo navegador. Ação sem
-- `sku_id` (nenhuma hoje, mas o schema permite) grava snapshot vazio — sem
-- SKU não há o que fotografar, e travar a decisão inteira por isso seria
-- pior que registrar sem baseline.
create function public.create_action_decision(
  p_action_id uuid,
  p_decision text
)
returns public.action_decisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.actions;
  snapshot jsonb;
  result public.action_decisions;
begin
  select * into a from public.actions where id = p_action_id;

  if a.id is null then
    raise exception 'ação % não encontrada', p_action_id;
  end if;

  if not private.is_member_of(a.organization_id) then
    raise exception 'sem permissao para registrar decisao nesta acao';
  end if;

  if p_decision is null or btrim(p_decision) = '' then
    raise exception 'decisao nao pode ser vazia';
  end if;

  snapshot := case
    when a.sku_id is not null then
      public.get_sku_decision_snapshot(a.organization_id, a.sku_id, (current_date - 1))
    else
      '{}'::jsonb
  end;

  insert into public.action_decisions (organization_id, action_id, decision, baseline_snapshot, created_by)
  values (a.organization_id, p_action_id, btrim(p_decision), snapshot, (select auth.uid()))
  returning * into result;

  return result;
end;
$$;

comment on function public.create_action_decision(uuid, text) is
  'Registra uma decisão a partir de uma ação, capturando baseline_snapshot na hora (get_sku_decision_snapshot, as_of = ontem, mesmo raciocínio de frescor de /vendas). Autorização (membro da organização da ação) refeita internamente.';

revoke all on function public.create_action_decision(uuid, text) from public, anon;
grant execute on function public.create_action_decision(uuid, text) to authenticated, service_role;
