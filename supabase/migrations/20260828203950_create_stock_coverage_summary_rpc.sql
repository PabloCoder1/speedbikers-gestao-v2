-- Os totais da tela de cobertura saem do Postgres, nao de `.filter().length`
-- sobre a fatia que voltou (D-131).
--
-- O defeito medido: `apps/web/app/cobertura/page.tsx` chamava
-- `get_stock_coverage` sem `.range()`, recebia 1.000 das 2.602 linhas por
-- causa de `max_rows`, e entao contava ruptura e estoque virtual EM
-- JAVASCRIPT sobre essa fatia. O numero no cabecalho da tela era uma contagem
-- sobre amostra arbitraria -- e a ruptura real e 924.
--
-- Isso viola `docs/ARCHITECTURE.md` secao 15/21 duas vezes: agrega em
-- JavaScript, e agrega sobre dado incompleto. A segunda e a que produz numero
-- errado com cara de certo.
--
-- Funcao separada, e nao colunas de total repetidas em cada linha de
-- `get_stock_coverage`: repetir o total em 2.602 linhas para ler o valor da
-- primeira e desperdicio, e a tela precisa dos totais mesmo quando pede so a
-- primeira pagina.

create function public.get_stock_coverage_summary(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  total bigint,
  em_ruptura bigint,
  virtuais bigint,
  sem_cobertura bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*)::bigint as total,
    count(*) filter (where c.is_ruptura)::bigint as em_ruptura,
    count(*) filter (where c.stock_is_virtual)::bigint as virtuais,
    count(*) filter (where c.days_of_coverage is null and not c.stock_is_virtual)::bigint as sem_cobertura
  from public.get_stock_coverage(p_organization_id, p_date_from, p_date_to) c
$$;

comment on function public.get_stock_coverage_summary is
  'Totais da tela de cobertura (D-131): total, em ruptura, com estoque virtual e sem cobertura calculavel. Existe porque a tela contava em JavaScript sobre um resultado truncado em 1.000 linhas pelo max_rows do PostgREST -- contagem sobre amostra arbitraria. `sem_cobertura` exclui os virtuais de proposito: para esses o nulo e recusa deliberada (D-127), nao ausencia de venda.';

revoke all on function public.get_stock_coverage_summary(uuid, date, date) from public, anon;
grant execute on function public.get_stock_coverage_summary(uuid, date, date) to authenticated, service_role;
