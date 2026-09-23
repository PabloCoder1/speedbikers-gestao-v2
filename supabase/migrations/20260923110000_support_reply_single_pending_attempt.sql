-- Central de Atendimento — trava física de envio por caso.
--
-- `client_request_id` já elimina duplo clique e retry do MESMO navegador.
-- Isso não cobria dois operadores confirmando textos diferentes para a mesma
-- pergunta ao mesmo tempo: as duas linhas PENDING podiam passar pela
-- revalidação remota antes de uma delas concluir o POST. Uma tentativa PENDING
-- é justamente estado "não sabemos se saiu"; enquanto ela existir, abrir outra
-- tentativa para o mesmo atendimento seria induzir uma resposta duplicada.
--
-- A constraint é parcial porque o histórico é append-only: tentativas
-- SUCCEEDED/FAILED continuam coexistindo, mas apenas UMA pendente é permitida.

create unique index support_reply_attempts_one_pending_case_idx
  on public.support_reply_attempts (support_case_id)
  where status = 'PENDING';

comment on index public.support_reply_attempts_one_pending_case_idx is
  'Uma única tentativa de resposta PENDING por atendimento; protege a corrida entre operadores com client_request_id distintos.';
