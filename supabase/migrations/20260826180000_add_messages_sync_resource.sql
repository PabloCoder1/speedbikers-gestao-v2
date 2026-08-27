-- Reconciliação de Mensagens pós-venda (Fase 7B).
--
-- Mesmo raciocínio de `20260825180000`, quando 'questions' entrou: o job por
-- conversa (`sync.support.messages`) é um fetch pontual e continua vivendo só
-- em `job_runs`. Quem ganha linha em `sync_runs` é a VARREDURA por conta, que
-- tem janela, contagem de itens e um "última vez que reconciliamos" real para
-- a tela de Saúde da Sincronização mostrar.
--
-- `drop constraint` + `add constraint` porque um CHECK não é substituível no
-- lugar — terceira vez que este alargamento acontece com este formato.

alter table public.sync_runs drop constraint sync_runs_resource_check;
alter table public.sync_runs add constraint sync_runs_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits', 'questions', 'messages']));

alter table public.sync_errors drop constraint sync_errors_resource_check;
alter table public.sync_errors add constraint sync_errors_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits', 'questions', 'messages']));
