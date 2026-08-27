-- Reconciliação de Reclamações (Fase 7B, D-108).
--
-- Mesmo raciocínio de `20260825180000` ('questions') e `20260826180000`
-- ('messages'): o consumo por claim vindo do webhook é um fetch pontual e
-- continua vivendo só em `job_runs`. Quem ganha linha em `sync_runs` é a
-- VARREDURA por conta, que tem janela, contagem de itens e um "última vez que
-- reconciliamos" real para a tela de Saúde da Sincronização mostrar.
--
-- Diferente de 'questions', esta varredura tem janela DE VERDADE: a busca de
-- reclamações aceita `range=last_updated:after:...`, filtro que a busca de
-- Perguntas não tem (D-089). Por isso `latest_record_at` aqui é um checkpoint
-- utilizável, não só um carimbo informativo.
--
-- `drop constraint` + `add constraint` porque um CHECK não é substituível no
-- lugar — quarta vez que este alargamento acontece com este formato.

alter table public.sync_runs drop constraint sync_runs_resource_check;
alter table public.sync_runs add constraint sync_runs_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits', 'questions', 'messages', 'claims']));

alter table public.sync_errors drop constraint sync_errors_resource_check;
alter table public.sync_errors add constraint sync_errors_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits', 'questions', 'messages', 'claims']));
