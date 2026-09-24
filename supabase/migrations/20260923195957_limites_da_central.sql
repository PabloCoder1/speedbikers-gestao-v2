-- D-408 — Os limites da central nas configurações.
--
-- Os cortes que julgam os números da central moravam no código como
-- "provisórios" (D-148: limiar é decisão do dono, não constante): quanto um
-- indicador precisa mudar para deixar de ser estável e para virar perigo,
-- quanto atraso da meta ainda é atenção, a amostra mínima de pedidos para
-- comparar razões e a margem depois do Ads abaixo da qual escalar não é
-- recomendado. Esta tabela os guarda por organização; sem linha, valem os
-- padrões -- os mesmos números de antes, então nada muda até alguém mudar.
--
-- Todos em fração: 0,02 = 2%; nos pontos percentuais, 0,005 = 0,5 p.p.
-- Os limites que moram no SQL (a margem de 10% de `get_faturamento`, os
-- sinais de Ads e o detector de frete) ficam para uma fatia própria.

create table public.central_thresholds (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  change_neutral numeric(6,4) not null default 0.02,
  change_strong numeric(6,4) not null default 0.10,
  points_neutral numeric(6,4) not null default 0.005,
  points_strong numeric(6,4) not null default 0.02,
  goal_delay_warning numeric(6,4) not null default 0.05,
  margin_after_ads_low numeric(6,4) not null default 0.10,
  min_orders_sample integer not null default 20,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint central_thresholds_change_check
    check (change_neutral > 0 and change_neutral < change_strong and change_strong <= 1),
  constraint central_thresholds_points_check
    check (points_neutral > 0 and points_neutral < points_strong and points_strong <= 0.2),
  constraint central_thresholds_goal_delay_check
    check (goal_delay_warning > 0 and goal_delay_warning < 1),
  constraint central_thresholds_margin_check
    check (margin_after_ads_low >= 0 and margin_after_ads_low < 1),
  constraint central_thresholds_sample_check
    check (min_orders_sample between 1 and 1000)
);

create trigger central_thresholds_set_updated_at
  before update on public.central_thresholds
  for each row execute function private.set_updated_at();

alter table public.central_thresholds enable row level security;

create policy central_thresholds_select_member
  on public.central_thresholds for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy central_thresholds_insert_admin
  on public.central_thresholds for insert to authenticated
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy central_thresholds_update_admin
  on public.central_thresholds for update to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy central_thresholds_delete_admin
  on public.central_thresholds for delete to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.central_thresholds from anon, authenticated;
grant select, insert, update, delete on public.central_thresholds to authenticated;
grant all on public.central_thresholds to service_role;

comment on table public.central_thresholds is
  'Limites que julgam os números da central (D-408), uma linha por organização: variação estável e forte (em valor e em pontos percentuais), atraso da meta que ainda é atenção, margem depois do Ads baixa demais para escalar e amostra mínima de pedidos. Sem linha, valem os padrões (os de antes). Escrita ADMIN/GESTOR; apagar a linha volta aos padrões.';
