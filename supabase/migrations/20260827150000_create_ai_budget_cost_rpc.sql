-- Aviso de orçamento de IA (D-100) — a soma que faltava desde D-082.
--
-- `ai_runs.cost_usd` acumula o custo real de cada chamada com LLM desde
-- 2026-08-25, mas nada somava o mês nem avisava ninguém: na prática o
-- gasto com a Anthropic era ilimitado e não observado (registrado como
-- "pendência mais antiga do projeto" em docs/HANDOFF.md). Esta RPC é a
-- metade SQL do mecanismo: soma no banco (docs/ARCHITECTURE.md secao 21,
-- zero agregação em JS), com o índice que já existe desde a criação da
-- tabela (`ai_runs_organization_created_at_idx`, exatamente este par).
--
-- `security invoker`, mesmo raciocínio de get_stock_coverage: sem lógica
-- de autorização própria, a RLS de `ai_runs` decide o alcance — o worker
-- (service_role) soma a organização inteira; um ADMIN/GESTOR autenticado
-- também (policy `ai_runs_select_own_or_admin`); um usuário comum somaria
-- apenas as PRÓPRIAS chamadas, o que é coerente para uma futura tela de
-- consumo pessoal.
--
-- Half-open [from, to): o chamador passa o primeiro instante do mês de
-- negócio (America/Sao_Paulo) e o agora — nenhuma linha escapa nem conta
-- duas vezes na virada do mês.

create function public.get_ai_monthly_cost_usd(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(r.cost_usd), 0)
  from public.ai_runs r
  where r.organization_id = p_organization_id
    and r.created_at >= p_from
    and r.created_at < p_to
$$;

comment on function public.get_ai_monthly_cost_usd(uuid, timestamptz, timestamptz) is
  'Soma de ai_runs.cost_usd no intervalo [from, to) — metade SQL do aviso de orçamento de IA (D-100, teto decidido em D-082). security invoker: a RLS de ai_runs decide o alcance de quem chama.';

revoke all on function public.get_ai_monthly_cost_usd(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_ai_monthly_cost_usd(uuid, timestamptz, timestamptz) to authenticated, service_role;
