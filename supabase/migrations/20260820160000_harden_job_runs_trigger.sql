-- ============================================================
-- Endurece a função de trigger da `job_runs`.
--
-- O linter de seguranca do Supabase apontou `search_path` mutavel em
-- `public.job_runs_reject_mutation`. A migration original definiu
-- `set search_path = ''` em todas as funcoes da identidade, mas esta ficou de
-- fora.
--
-- Por que importa mesmo sem `security definer`: um `search_path` manipulavel
-- permite que um objeto criado por outro papel seja resolvido no lugar do
-- pretendido. O custo de fechar e uma linha; o de deixar aberto so aparece
-- quando alguem explora.
--
-- Aproveita para mover a funcao para `private`, junto das demais. `public` e o
-- schema exposto pelo PostgREST e deve conter tabelas, nao maquinaria interna.
-- ============================================================

create or replace function private.job_runs_reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'job_runs e append-only: % nao e permitido. Corrija inserindo uma nova linha.',
    tg_op;
end;
$$;

comment on function private.job_runs_reject_mutation is
  'Impede UPDATE e DELETE em job_runs, tornando o contrato append-only fisico.';

drop trigger if exists job_runs_no_update on public.job_runs;
drop trigger if exists job_runs_no_delete on public.job_runs;

create trigger job_runs_no_update
  before update on public.job_runs
  for each row execute function private.job_runs_reject_mutation();

create trigger job_runs_no_delete
  before delete on public.job_runs
  for each row execute function private.job_runs_reject_mutation();

drop function if exists public.job_runs_reject_mutation();
