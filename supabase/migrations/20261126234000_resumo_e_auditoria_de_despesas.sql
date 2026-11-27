-- Central de Inteligência Financeira: o resumo das despesas operacionais sai do SQL.
--
-- A DRE, o Ponto de Equilíbrio, as metas e os alertas de custo liam as linhas de
-- `operational_expenses` com `limit(1000)` e somavam em JavaScript. Passado de
-- mil lançamentos no intervalo, a soma ficava truncada em silêncio — o oposto da
-- regra "agregação em SQL, nunca em JavaScript" e de "ausência de dado não vira
-- zero". Esta função devolve o mesmo resumo já agregado, para o período atual e
-- para o anterior, em UMA chamada.
--
-- Regras (espelhadas por `agregarDespesasNoPeriodo`, em apps/web/lib/custos-fiscal.ts,
-- e provadas iguais pelos dois testes sobre a mesma fixture):
--   * canceladas ficam fora;
--   * a despesa pertence ao período pela data de COMPETÊNCIA;
--   * o valor da DRE é o realizado quando existe, senão o previsto;
--   * fixas / variáveis saem NULAS quando não há lançamento daquele tipo — o
--     cadastro ausente nunca vira R$ 0,00;
--   * "atrasada" = status atrasada, ou prevista com vencimento anterior a hoje.
--
-- SECURITY INVOKER (o padrão): a RLS de `operational_expenses` continua valendo,
-- então quem não é da organização lê um resumo vazio, nunca o de outra.

create or replace function public.get_resumo_despesas(
  p_organization_id uuid,
  p_from date,
  p_to date,
  p_anterior_from date,
  p_anterior_to date,
  p_hoje date default null
)
returns jsonb
language sql
stable
set search_path to ''
as $function$
  with hoje as (
    select coalesce(p_hoje, (now() at time zone 'America/Sao_Paulo')::date) as dia
  ),
  periodos(periodo, d_from, d_to) as (
    values ('atual', p_from, p_to), ('anterior', p_anterior_from, p_anterior_to)
  ),
  agregado as (
    select
      p.periodo,
      sum(coalesce(e.actual_amount, e.planned_amount)) filter (where e.cost_type = 'fixo') as despesas_fixas,
      sum(coalesce(e.actual_amount, e.planned_amount)) filter (where e.cost_type = 'variavel') as despesas_variaveis,
      count(e.id) as quantidade,
      coalesce(sum(e.planned_amount), 0) as total_previsto,
      coalesce(sum(e.actual_amount), 0) as total_realizado,
      count(e.id) filter (
        where e.status = 'atrasada'
           or (e.status = 'prevista' and e.due_date is not null and e.due_date < (select dia from hoje))
      ) as atrasadas
    from periodos p
    left join public.operational_expenses e
      on e.organization_id = p_organization_id
     and e.status <> 'cancelada'
     and e.competence_date between p.d_from and p.d_to
    group by p.periodo
  )
  select jsonb_build_object(
    'atual', (select to_jsonb(a) - 'periodo' from agregado a where a.periodo = 'atual'),
    'anterior', (select to_jsonb(a) - 'periodo' from agregado a where a.periodo = 'anterior')
  );
$function$;

comment on function public.get_resumo_despesas(uuid, date, date, date, date, date) is
  'Resumo agregado das despesas operacionais (fixas, variáveis, previsto, realizado, atrasadas) por competência, no período atual e no anterior. Fixas/variáveis nulas sem lançamento; canceladas fora; RLS do chamador.';

revoke all on function public.get_resumo_despesas(uuid, date, date, date, date, date) from public, anon;
grant execute on function public.get_resumo_despesas(uuid, date, date, date, date, date) to authenticated, service_role;

-- ─── Trilha de auditoria das despesas: gravada pelo banco, não pelo app ───────
--
-- Até aqui `operational_expense_history` era escrita pelas Server Actions, e a
-- policy de INSERT deixava qualquer ADMIN/GESTOR gravar evento FALSO — a trilha
-- podia ser forjada ou simplesmente esquecida (a action que falha entre o
-- UPDATE e o INSERT deixa a mudança sem rastro). Agora um trigger registra cada
-- criação e cada alteração, com o antes e o depois completos (`to_jsonb`), e a
-- escrita direta na tabela sai de `authenticated`: só o trigger escreve.
--
--   * INSERT  -> 'created' (after_data = a linha);
--   * UPDATE  -> 'status_changed' quando o status muda, senão 'updated'
--                (before_data / after_data); atualização que só mexe em
--                `updated_at` / `updated_by` não gera evento;
--   * DELETE  -> sem evento: o histórico referencia a despesa com
--                `on delete cascade`, então a remoção apaga a própria trilha.
--                A tela pede confirmação e a preferência é CANCELAR (a linha e
--                o rastro ficam).
--
-- SECURITY DEFINER porque o chamador não tem mais INSERT na tabela; `search_path`
-- vazio e nenhum parâmetro vindo do usuário. `changed_by` usa o default
-- `auth.uid()`, que lê o JWT da sessão que disparou o trigger.

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
  end if;

  return null;
end;
$function$;

revoke all on function private.audit_operational_expense() from public, anon, authenticated;

create trigger operational_expenses_audit
  after insert or update on public.operational_expenses
  for each row execute function private.audit_operational_expense();

drop policy operational_expense_history_insert_admin on public.operational_expense_history;
revoke insert on public.operational_expense_history from authenticated;

-- ─── Faturamento agregado por conta (para rateio ponderado em SQL) ───────────
--
-- Soma `gross_revenue` em `daily_account_metrics` no intervalo pedido, agrupado
-- por `ml_account_id`, para que o rateio de custos compartilhados em
-- `/central/custos` use faturamento real sem carregar linhas brutas em JS.
-- SECURITY INVOKER: respeita a RLS de `daily_account_metrics`.

create or replace function public.get_faturamento_por_conta(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns table (
  ml_account_id uuid,
  receita_bruta numeric
)
language sql
stable
set search_path to ''
as $function$
  select
    m.ml_account_id,
    round(coalesce(sum(m.gross_revenue), 0), 2) as receita_bruta
  from public.daily_account_metrics m
  where m.organization_id = p_organization_id
    and m.metric_date between p_from and p_to
  group by m.ml_account_id;
$function$;

comment on function public.get_faturamento_por_conta(uuid, date, date) is
  'Faturamento bruto agregado em SQL por conta do Mercado Livre no intervalo, para rateio ponderado de despesas compartilhadas. SECURITY INVOKER (RLS).';

revoke all on function public.get_faturamento_por_conta(uuid, date, date) from public, anon;
grant execute on function public.get_faturamento_por_conta(uuid, date, date) to authenticated, service_role;
