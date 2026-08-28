-- Terceira ocorrência do defeito que D-099 corrigiu, criada no dia seguinte
-- por D-113: `knowledge_entries.created_by`/`confirmed_by` nasceram
-- `on delete set null`, o padrão que D-099 acabara de eliminar das colunas de
-- ator.
--
-- Aqui a colisão é ainda mais direta: `knowledge_entries_validation_coherent`
-- exige `confirmed_by is not null` quando `status = 'VALIDADO'`. O SET NULL
-- dispara um UPDATE que a própria constraint recusa — deletar um usuário que
-- já validou um conhecimento falha com "violates check constraint", apontando
-- para o lugar errado. D-113 escreveu que "confirmação anônima não existe" e
-- a FK tentava criar exatamente isso.
--
-- `restrict` mantém o bloqueio (linha de auditoria não sobrevive sem o ator,
-- mesmo raciocínio de `stock_movements.created_by`) e devolve o diagnóstico
-- correto: "violates foreign key constraint". Precedente para tabela NÃO
-- append-only referenciando `auth.users`: `action_decisions.created_by`
-- (20260824123358), também `on delete restrict`.

alter table public.knowledge_entries
  drop constraint knowledge_entries_created_by_fkey,
  add constraint knowledge_entries_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete restrict;

alter table public.knowledge_entries
  drop constraint knowledge_entries_confirmed_by_fkey,
  add constraint knowledge_entries_confirmed_by_fkey
    foreign key (confirmed_by) references auth.users(id) on delete restrict;
