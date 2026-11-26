-- Central de Inteligência Financeira: integridade entre organizações, trilha que
-- sobrevive à exclusão e trava do mês fechado.
--
-- Revisão cruzada do #424 (fundação 20261126233000 e auditoria 20261126234000),
-- feita antes de as duas chegarem à produção:
--
-- 1. As tabelas novas apontavam para `fiscal_entities`, `operational_expenses`,
--    `ml_accounts` e `shopee_shops` só por `id`. A RLS confere o
--    `organization_id` da linha nova, mas a chave estrangeira não passa pela
--    RLS: um GESTOR da organização A conseguia vincular o CNPJ, a conta do ML ou
--    a loja da Shopee da organização B. Agora toda referência é composta
--    `(x_id, organization_id)`, no padrão que `shopee_shops` já usa
--    (`shopee_shops_id_organizacao_unica`, 20261014180000).
-- 2. `operational_expense_history.expense_id` tinha `on delete cascade`: apagar a
--    despesa apagava o rastro, e o evento 'deleted' nunca era gravado. A trilha
--    deixa de depender da linha viva, e o trigger passa a gravar a exclusão.
-- 3. O fechamento mensal não travava nada. Agora a despesa cuja competência está
--    num mês `fechado` não é criada, alterada nem apagada; para mexer, o mês é
--    reaberto. O fechamento deixa de ser apagável pela sessão (`reaberto` é o
--    caminho, e fica registrado).
--
-- Fora daqui: o rateio por faturamento ainda dá peso zero à Shopee, porque
-- `get_faturamento_por_conta` só lê o ML. Isso muda a tela e fica com o autor.

-- ─── 1. Referências da mesma organização ──────────────────────────────────

alter table public.ml_accounts
  add constraint ml_accounts_id_organizacao_unica unique (id, organization_id);

alter table public.fiscal_entities
  add constraint fiscal_entities_id_organizacao_unica unique (id, organization_id);

alter table public.operational_expenses
  add constraint operational_expenses_id_organizacao_unica unique (id, organization_id);

alter table public.fiscal_entity_accounts
  drop constraint fiscal_entity_accounts_fiscal_entity_id_fkey,
  drop constraint fiscal_entity_accounts_ml_account_id_fkey,
  drop constraint fiscal_entity_accounts_shopee_shop_id_fkey,
  add constraint fiscal_entity_accounts_entidade_mesma_org
    foreign key (fiscal_entity_id, organization_id)
    references public.fiscal_entities (id, organization_id) on delete cascade,
  add constraint fiscal_entity_accounts_conta_ml_mesma_org
    foreign key (ml_account_id, organization_id)
    references public.ml_accounts (id, organization_id) on delete cascade,
  add constraint fiscal_entity_accounts_loja_shopee_mesma_org
    foreign key (shopee_shop_id, organization_id)
    references public.shopee_shops (id, organization_id) on delete cascade;

alter table public.fiscal_entity_tax_configs
  drop constraint fiscal_entity_tax_configs_fiscal_entity_id_fkey,
  add constraint fiscal_entity_tax_configs_entidade_mesma_org
    foreign key (fiscal_entity_id, organization_id)
    references public.fiscal_entities (id, organization_id) on delete cascade;

-- `set null (coluna)`: só a referência vira nula; o organization_id fica.
alter table public.operational_expenses
  drop constraint operational_expenses_fiscal_entity_id_fkey,
  drop constraint operational_expenses_ml_account_id_fkey,
  drop constraint operational_expenses_shopee_shop_id_fkey,
  add constraint operational_expenses_entidade_mesma_org
    foreign key (fiscal_entity_id, organization_id)
    references public.fiscal_entities (id, organization_id) on delete set null (fiscal_entity_id),
  add constraint operational_expenses_conta_ml_mesma_org
    foreign key (ml_account_id, organization_id)
    references public.ml_accounts (id, organization_id) on delete set null (ml_account_id),
  add constraint operational_expenses_loja_shopee_mesma_org
    foreign key (shopee_shop_id, organization_id)
    references public.shopee_shops (id, organization_id) on delete set null (shopee_shop_id);

alter table public.operational_expense_allocations
  drop constraint operational_expense_allocations_expense_id_fkey,
  add constraint operational_expense_allocations_despesa_mesma_org
    foreign key (expense_id, organization_id)
    references public.operational_expenses (id, organization_id) on delete cascade;

-- ─── 2. A trilha sobrevive à exclusão ─────────────────────────────────────

-- Sem FK para a despesa: o evento 'deleted' fica depois que a linha some. Quem
-- escreve na tabela é só o trigger (o INSERT da sessão saiu em 20261126234000),
-- então o expense_id gravado é sempre o de uma despesa que existiu.
alter table public.operational_expense_history
  drop constraint operational_expense_history_expense_id_fkey;

create or replace function private.audit_operational_expense()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    insert into public.operational_expense_history (organization_id, expense_id, action, before_data, after_data)
    values (new.organization_id, new.id, 'created', null, to_jsonb(new));
  elsif tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'updated_at' - 'updated_by') is not distinct from (to_jsonb(old) - 'updated_at' - 'updated_by') then
      return null;
    end if;

    insert into public.operational_expense_history (organization_id, expense_id, action, before_data, after_data)
    values (
      new.organization_id,
      new.id,
      case when new.status is distinct from old.status then 'status_changed' else 'updated' end,
      to_jsonb(old),
      to_jsonb(new)
    );
  elsif tg_op = 'DELETE' then
    insert into public.operational_expense_history (organization_id, expense_id, action, before_data, after_data)
    values (old.organization_id, old.id, 'deleted', to_jsonb(old), null);
  end if;

  return null;
end;
$function$;

revoke all on function private.audit_operational_expense() from public, anon, authenticated;

drop trigger operational_expenses_audit on public.operational_expenses;

create trigger operational_expenses_audit
  after insert or update or delete on public.operational_expenses
  for each row execute function private.audit_operational_expense();

-- ─── 3. Mês fechado não muda ──────────────────────────────────────────────

-- Sem errcode próprio (P0001): a tela mostra a mensagem do banco, que diz o
-- mês e o que fazer; 23514 cairia no "confira os campos".
-- security invoker: lê o fechamento pela RLS de quem escreve, que é membro da
-- organização da despesa (a RLS da despesa já exigiu isso).
create or replace function private.guard_operational_expense_closed_month()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if tg_op in ('UPDATE', 'DELETE') and exists (
    select 1
    from public.monthly_financial_closings c
    where c.organization_id = old.organization_id
      and c.month = date_trunc('month', old.competence_date)::date
      and c.status = 'fechado'
  ) then
    raise exception 'a competência % está fechada: reabra o mês antes de alterar a despesa',
      to_char(old.competence_date, 'MM/YYYY');
  end if;

  if tg_op in ('INSERT', 'UPDATE') and exists (
    select 1
    from public.monthly_financial_closings c
    where c.organization_id = new.organization_id
      and c.month = date_trunc('month', new.competence_date)::date
      and c.status = 'fechado'
  ) then
    raise exception 'a competência % está fechada: reabra o mês antes de lançar a despesa',
      to_char(new.competence_date, 'MM/YYYY');
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

revoke all on function private.guard_operational_expense_closed_month() from public, anon, authenticated;

create trigger operational_expenses_mes_fechado
  before insert or update or delete on public.operational_expenses
  for each row execute function private.guard_operational_expense_closed_month();

-- O fechamento não some pela sessão: para voltar a editar, o mês é reaberto.
drop policy monthly_financial_closings_write_admin on public.monthly_financial_closings;

create policy monthly_financial_closings_insert_admin
  on public.monthly_financial_closings for insert to authenticated
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy monthly_financial_closings_update_admin
  on public.monthly_financial_closings for update to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke delete on public.monthly_financial_closings from authenticated;
