-- ============================================================
-- Central de Inteligência Financeira — Fundação de Dados (Fase 3)
--
-- Estruturas criadas:
-- 1. `fiscal_entities` + `fiscal_entity_accounts` + `fiscal_entity_tax_configs`
--    Entidades fiscais (CNPJs), vínculo com contas/lojas de marketplace e
--    configurações tributárias multi-regime com vigência histórica.
-- 2. `operational_expenses` + `operational_expense_allocations` + `operational_expense_history`
--    Gestão completa de custos fixos e variáveis, previsto vs. realizado,
--    recorrência com idempotência anti-duplicidade, rateio e auditoria.
-- 3. `financial_goals`
--    Metas financeiras expandidas (lucro líquido, margem do produto, margem de
--    contribuição, margem líquida, ticket médio, Ads, redução de despesas, etc.).
-- 4. `monthly_financial_closings`
--    Fechamento financeiro mensal auditável com snapshot e trava de edição retroativa.
--
-- Padrões do repositório respeitados:
-- - RLS habilitado em todas as tabelas com `private.accessible_orgs()` para leitura
--   e `private.has_org_role(organization_id, array['ADMIN','GESTOR'])` para escrita.
-- - Valores monetários em `numeric(14,2)` e alíquotas em `numeric(7,5)`.
-- - Nenhuma linha semeada com zero falso; ausência de dado permanece NULL.
-- ============================================================

-- ─── 1. Entidades Fiscais (CNPJs) e Regimes Tributários ───────

create table public.fiscal_entities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  legal_name text not null check (char_length(btrim(legal_name)) between 2 and 160),
  trade_name text check (trade_name is null or char_length(btrim(trade_name)) <= 160),
  cnpj text not null check (cnpj ~ '^[0-9]{14}$'),
  tax_regime text not null check (tax_regime in ('simples_nacional', 'lucro_presumido', 'lucro_real', 'configuravel')),
  active boolean not null default true,
  note text check (note is null or char_length(note) <= 500),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_entities_org_cnpj_key unique (organization_id, cnpj)
);

create trigger fiscal_entities_set_updated_at
  before update on public.fiscal_entities
  for each row execute function private.set_updated_at();

alter table public.fiscal_entities enable row level security;

create policy fiscal_entities_select_member
  on public.fiscal_entities for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy fiscal_entities_insert_admin
  on public.fiscal_entities for insert to authenticated
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy fiscal_entities_update_admin
  on public.fiscal_entities for update to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy fiscal_entities_delete_admin
  on public.fiscal_entities for delete to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.fiscal_entities from anon, authenticated;
grant select, insert, update, delete on public.fiscal_entities to authenticated;
grant all on public.fiscal_entities to service_role;

comment on table public.fiscal_entities is
  'Empresas/CNPJs da organização para apuração tributária gerencial individualizada por regime (Simples Nacional, Lucro Presumido, Lucro Real ou Configurável).';

create table public.fiscal_entity_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fiscal_entity_id uuid not null references public.fiscal_entities(id) on delete cascade,
  marketplace text not null check (marketplace in ('MERCADO_LIVRE', 'SHOPEE')),
  ml_account_id uuid references public.ml_accounts(id) on delete cascade,
  shopee_shop_id uuid references public.shopee_shops(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((marketplace = 'MERCADO_LIVRE') = (ml_account_id is not null)),
  check ((marketplace = 'SHOPEE') = (shopee_shop_id is not null))
);

create unique index fiscal_entity_accounts_ml_unique
  on public.fiscal_entity_accounts (organization_id, ml_account_id)
  where ml_account_id is not null;

create unique index fiscal_entity_accounts_shopee_unique
  on public.fiscal_entity_accounts (organization_id, shopee_shop_id)
  where shopee_shop_id is not null;

alter table public.fiscal_entity_accounts enable row level security;

create policy fiscal_entity_accounts_select_member
  on public.fiscal_entity_accounts for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy fiscal_entity_accounts_write_admin
  on public.fiscal_entity_accounts for all to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.fiscal_entity_accounts from anon, authenticated;
grant select, insert, update, delete on public.fiscal_entity_accounts to authenticated;
grant all on public.fiscal_entity_accounts to service_role;

comment on table public.fiscal_entity_accounts is
  'Vínculo exclusivo (1 conta → 1 CNPJ) entre contas do Mercado Livre ou lojas da Shopee e sua entidade fiscal.';

create table public.fiscal_entity_tax_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fiscal_entity_id uuid not null references public.fiscal_entities(id) on delete cascade,
  tax_regime text not null check (tax_regime in ('simples_nacional', 'lucro_presumido', 'lucro_real', 'configuravel')),
  valid_from date not null,
  nominal_rate numeric(7,5) not null check (nominal_rate >= 0 and nominal_rate < 1),
  effective_sales_rate numeric(7,5) not null check (effective_sales_rate >= 0 and effective_sales_rate < 1),
  tax_credits_rate numeric(7,5) not null default 0 check (tax_credits_rate >= 0 and tax_credits_rate < 1),
  profit_tax_rate numeric(7,5) not null default 0 check (profit_tax_rate >= 0 and profit_tax_rate < 1),
  calculation_base text not null default 'faturamento_bruto' check (char_length(btrim(calculation_base)) between 2 and 80),
  is_estimate boolean not null default true,
  validated_by_accountant boolean not null default false,
  source_note text check (source_note is null or char_length(source_note) <= 500),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_entity_tax_configs_entity_valid_from_key unique (fiscal_entity_id, valid_from)
);

create trigger fiscal_entity_tax_configs_set_updated_at
  before update on public.fiscal_entity_tax_configs
  for each row execute function private.set_updated_at();

alter table public.fiscal_entity_tax_configs enable row level security;

create policy fiscal_entity_tax_configs_select_member
  on public.fiscal_entity_tax_configs for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy fiscal_entity_tax_configs_write_admin
  on public.fiscal_entity_tax_configs for all to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.fiscal_entity_tax_configs from anon, authenticated;
grant select, insert, update, delete on public.fiscal_entity_tax_configs to authenticated;
grant all on public.fiscal_entity_tax_configs to service_role;

comment on table public.fiscal_entity_tax_configs is
  'Vigência histórica das alíquotas, base de cálculo e créditos tributários de cada entidade fiscal. Alterações criam nova vigência sem distorcer meses anteriores.';

-- ─── 2. Despesas Operacionais (Fixas e Variáveis) e Rateio ───

create table public.operational_expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fiscal_entity_id uuid references public.fiscal_entities(id) on delete set null,
  ml_account_id uuid references public.ml_accounts(id) on delete set null,
  shopee_shop_id uuid references public.shopee_shops(id) on delete set null,
  marketplace text check (marketplace is null or marketplace in ('MERCADO_LIVRE', 'SHOPEE', 'TODOS')),
  name text not null check (char_length(btrim(name)) between 2 and 140),
  description text check (description is null or char_length(description) <= 500),
  category text not null check (
    category in (
      'energia_eletrica', 'agua', 'internet', 'aluguel', 'condominio',
      'salarios', 'encargos_trabalhistas', 'beneficios', 'pro_labore',
      'contabilidade', 'softwares_assinaturas', 'sistemas_gestao',
      'infraestrutura_nuvem', 'banco_dados', 'embalagens', 'materiais_escritorio',
      'manutencao', 'equipamentos', 'seguros', 'servicos_terceirizados',
      'despesas_bancarias', 'despesas_administrativas', 'despesas_extraordinarias',
      'logistica_full_armazenagem', 'outras'
    )
  ),
  subcategory text check (subcategory is null or char_length(subcategory) <= 100),
  cost_type text not null check (cost_type in ('fixo', 'variavel')),
  recurrence text not null default 'mensal' check (recurrence in ('pontual', 'mensal', 'trimestral', 'anual', 'sazonal')),
  allocation_method text not null default 'faturamento' check (allocation_method in ('direto', 'faturamento', 'volume_vendas', 'percentual_fixo', 'manual')),
  cost_center text check (cost_center is null or char_length(cost_center) <= 100),
  planned_amount numeric(14,2) not null check (planned_amount >= 0),
  actual_amount numeric(14,2) check (actual_amount is null or actual_amount >= 0),
  competence_date date not null,
  due_date date,
  paid_date date,
  status text not null default 'prevista' check (status in ('prevista', 'paga', 'atrasada', 'cancelada')),
  idempotency_key text,
  note text check (note is null or char_length(note) <= 500),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index operational_expenses_org_idempotency_unique
  on public.operational_expenses (organization_id, idempotency_key)
  where idempotency_key is not null;

create index operational_expenses_org_competence_idx
  on public.operational_expenses (organization_id, competence_date desc, cost_type);

create trigger operational_expenses_set_updated_at
  before update on public.operational_expenses
  for each row execute function private.set_updated_at();

alter table public.operational_expenses enable row level security;

create policy operational_expenses_select_member
  on public.operational_expenses for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy operational_expenses_write_admin
  on public.operational_expenses for all to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.operational_expenses from anon, authenticated;
grant select, insert, update, delete on public.operational_expenses to authenticated;
grant all on public.operational_expenses to service_role;

comment on table public.operational_expenses is
  'Despesas operacionais fixas e variáveis da empresa (previsto vs. realizado, competência/vencimento/pagamento, recorrência, rateio e chave de idempotência anti-duplicidade).';

create table public.operational_expense_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  expense_id uuid not null references public.operational_expenses(id) on delete cascade,
  target_type text not null check (target_type in ('fiscal_entity', 'marketplace', 'ml_account', 'shopee_shop')),
  target_id text not null check (char_length(btrim(target_id)) between 1 and 80),
  target_label text not null check (char_length(btrim(target_label)) between 1 and 140),
  allocation_percentage numeric(7,5) not null check (allocation_percentage >= 0 and allocation_percentage <= 1),
  allocated_amount numeric(14,2) not null check (allocated_amount >= 0),
  created_at timestamptz not null default now()
);

create index operational_expense_allocations_expense_idx
  on public.operational_expense_allocations (expense_id);

alter table public.operational_expense_allocations enable row level security;

create policy operational_expense_allocations_select_member
  on public.operational_expense_allocations for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy operational_expense_allocations_write_admin
  on public.operational_expense_allocations for all to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.operational_expense_allocations from anon, authenticated;
grant select, insert, update, delete on public.operational_expense_allocations to authenticated;
grant all on public.operational_expense_allocations to service_role;

create table public.operational_expense_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  expense_id uuid not null references public.operational_expenses(id) on delete cascade,
  action text not null check (action in ('created', 'updated', 'status_changed', 'deleted')),
  before_data jsonb,
  after_data jsonb,
  changed_by uuid default auth.uid() references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index operational_expense_history_expense_idx
  on public.operational_expense_history (expense_id, changed_at desc);

alter table public.operational_expense_history enable row level security;

create policy operational_expense_history_select_member
  on public.operational_expense_history for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy operational_expense_history_insert_admin
  on public.operational_expense_history for insert to authenticated
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.operational_expense_history from anon, authenticated;
grant select, insert on public.operational_expense_history to authenticated;
grant all on public.operational_expense_history to service_role;

-- ─── 3. Metas Financeiras Expandidas ──────────────────────────

create table public.financial_goals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  metric_kind text not null check (
    metric_kind in (
      'faturamento_bruto', 'receita_liquida', 'lucro_liquido',
      'margem_produto', 'margem_contribuicao', 'margem_liquida',
      'quantidade_vendas', 'ticket_medio', 'investimento_ads',
      'reducao_despesas', 'eficiencia_logistica'
    )
  ),
  scope_kind text not null default 'global' check (scope_kind in ('global', 'marketplace', 'account', 'brand')),
  scope_ref text,
  target_value numeric(14,4) not null,
  note text check (note is null or char_length(note) <= 300),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index financial_goals_unique_scope
  on public.financial_goals (organization_id, month, metric_kind, scope_kind, coalesce(scope_ref, ''));

create trigger financial_goals_set_updated_at
  before update on public.financial_goals
  for each row execute function private.set_updated_at();

alter table public.financial_goals enable row level security;

create policy financial_goals_select_member
  on public.financial_goals for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy financial_goals_write_admin
  on public.financial_goals for all to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.financial_goals from anon, authenticated;
grant select, insert, update, delete on public.financial_goals to authenticated;
grant all on public.financial_goals to service_role;

comment on table public.financial_goals is
  'Metas financeiras expandidas (lucro líquido, margens, ticket médio, Ads, despesas e logística), globais ou por marketplace/conta/marca.';

-- ─── 4. Fechamento Financeiro Mensal Auditável ────────────────

create table public.monthly_financial_closings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  status text not null default 'aberto' check (status in ('aberto', 'fechado', 'reaberto')),
  dre_snapshot jsonb not null,
  notes text check (notes is null or char_length(notes) <= 1000),
  closed_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monthly_financial_closings_org_month_key unique (organization_id, month)
);

create trigger monthly_financial_closings_set_updated_at
  before update on public.monthly_financial_closings
  for each row execute function private.set_updated_at();

alter table public.monthly_financial_closings enable row level security;

create policy monthly_financial_closings_select_member
  on public.monthly_financial_closings for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy monthly_financial_closings_write_admin
  on public.monthly_financial_closings for all to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.monthly_financial_closings from anon, authenticated;
grant select, insert, update, delete on public.monthly_financial_closings to authenticated;
grant all on public.monthly_financial_closings to service_role;

comment on table public.monthly_financial_closings is
  'Fechamento financeiro mensal auditável com snapshot da DRE gerencial e controle de status (aberto, fechado, reaberto).';
