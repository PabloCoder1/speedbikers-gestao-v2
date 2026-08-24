-- Central de Ações (Fase 6, `docs/ARCHITECTURE.md` secao 16 / `docs/DATABASE.md`
-- secao 4) — problema e oportunidade são o mesmo objeto com sinal invertido,
-- por isso uma tabela só. Schema já estava documentado desde a Fase 0
-- (docs/DATABASE.md), esta migration só cria o que já estava desenhado.
--
-- Priorização por impacto x urgência x confiança, NUNCA por contagem de
-- alerta (docs/ARCHITECTURE.md secao 16 — a V2 chegou a 5.243 alertas
-- abertos, cinco mil alertas não são cinco mil problemas).

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  kind text not null,
  severity text not null check (severity in ('baixa', 'media', 'alta')),
  confidence text not null check (confidence in ('media', 'alta')),
  estimated_impact_brl numeric,

  ml_account_id uuid references public.ml_accounts(id) on delete set null,
  sku_id uuid references public.skus(id) on delete set null,
  mlb_id text,

  evidence jsonb not null,
  recommendation text not null,

  assignee_id uuid references auth.users(id) on delete set null,
  status text not null default 'novo' check (status in ('novo', 'em_andamento', 'resolvido', 'descartado')),
  created_by text not null check (created_by in ('system', 'user')),

  -- Chave estável por diagnóstico (ex.: "sales_anomaly:{sku_id}:{as_of}") —
  -- reprocessar o mesmo dia não duplica a ação, só atualiza evidência/impacto.
  dedup_key text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, dedup_key)
);

comment on table public.actions is
  'Central de Ações (Fase 6) — problema e oportunidade unificados, um objeto com sinal invertido. Escrita: worker grava direto via service_role (job de detecção, sem RPC — mesmo padrão de listings/visits sync); humano só muda status/assignee via update_action_status (security definer).';

create index actions_org_status_idx on public.actions (organization_id, status);

alter table public.actions enable row level security;

create policy actions_select_own_org
  on public.actions for select
  to authenticated
  using (private.is_member_of(organization_id));

-- Mesmo achado de D-062: GRANT precisa ser revogado de `authenticated`
-- explicitamente, não só de `anon` — privilégio padrão deste projeto
-- Supabase concede INSERT/UPDATE/DELETE em tabela nova por padrão.
revoke all on public.actions from anon, authenticated;
grant select on public.actions to authenticated;
grant all on public.actions to service_role;

create trigger actions_set_updated_at
  before update on public.actions
  for each row execute function private.set_updated_at();

create function public.update_action_status(
  p_id uuid,
  p_status text,
  p_assignee_id uuid default null
)
returns public.actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.actions;
  result public.actions;
begin
  select * into a from public.actions where id = p_id;

  if a.id is null then
    raise exception 'ação % não encontrada', p_id;
  end if;

  if not private.is_member_of(a.organization_id) then
    raise exception 'sem permissao para atualizar esta ação';
  end if;

  if p_status not in ('novo', 'em_andamento', 'resolvido', 'descartado') then
    raise exception 'status invalido: %', p_status;
  end if;

  update public.actions set
    status = p_status,
    assignee_id = coalesce(p_assignee_id, assignee_id)
  where id = p_id
  returning * into result;

  return result;
end;
$$;

comment on function public.update_action_status(uuid, text, uuid) is
  'Muda status/responsável de uma ação. Autorização (membro da organização) refeita internamente. p_assignee_id nulo mantém o responsável atual (não existe "desatribuir" nesta fatia).';

revoke all on function public.update_action_status(uuid, text, uuid) from public, anon;
grant execute on function public.update_action_status(uuid, text, uuid) to authenticated, service_role;

create function public.get_sku_average_prices(
  p_organization_id uuid,
  p_sku_ids uuid[],
  p_date_from date,
  p_date_to date
)
returns table (
  sku_id uuid,
  average_price numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    m.sku_id,
    round(avg(m.average_selling_price), 2) as average_price
  from public.daily_sku_metrics m
  where m.organization_id = p_organization_id
    and m.sku_id = any(p_sku_ids)
    and m.metric_date between p_date_from and p_date_to
    and m.average_selling_price is not null
  group by m.sku_id
$$;

comment on function public.get_sku_average_prices(uuid, uuid[], date, date) is
  'Preço médio praticado por SKU num intervalo — usado pelo job de detecção de anomalia (Fase 6, D-064) para estimar impacto financeiro. Só os SKUs pedidos (lista pequena, os já confirmados como anomalia), evita varrer o catálogo inteiro.';

revoke all on function public.get_sku_average_prices(uuid, uuid[], date, date) from public, anon;
grant execute on function public.get_sku_average_prices(uuid, uuid[], date, date) to authenticated, service_role;
