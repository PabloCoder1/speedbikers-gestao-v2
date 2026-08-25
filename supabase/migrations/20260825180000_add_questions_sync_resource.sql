-- Reconciliação de Perguntas do Mercado Livre (D-089, Fase 7B).
--
-- `sync.support.questions` (D-087) é um fetch por ID vindo do webhook: sem
-- varredura, sem contagem, sem frescor — `job_runs` já bastava, e D-087
-- registrou explicitamente a decisão de NÃO alargar este CHECK ali.
--
-- A reconciliação muda isso: ela varre o conjunto de perguntas em aberto de
-- uma conta, processa N itens e produz um "última vez que reconciliamos esta
-- conta" que a tela de Saúde da Sincronização precisa mostrar. Aí sim existe
-- execução com janela, contagem e frescor semanticamente reais.
--
-- Mesmo formato do alargamento anterior (`20260823184120`, quando 'visits'
-- entrou): `drop constraint` + `add constraint`, porque um CHECK não é
-- substituível no lugar.

alter table public.sync_runs drop constraint sync_runs_resource_check;
alter table public.sync_runs add constraint sync_runs_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits', 'questions']));

alter table public.sync_errors drop constraint sync_errors_resource_check;
alter table public.sync_errors add constraint sync_errors_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits', 'questions']));
