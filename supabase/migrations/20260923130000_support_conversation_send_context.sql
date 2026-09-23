-- Central de Atendimento — contexto remoto necessário para eventual envio de
-- mensagem pós-venda. Não habilita escrita: apenas preserva o que a conversa
-- autenticada já devolve, para a futura revalidação não inferir site ou limite.

alter table public.support_cases
  add column remote_site_id text
    check (remote_site_id is null or char_length(btrim(remote_site_id)) between 1 and 16),
  add column remote_max_message_length integer
    check (remote_max_message_length is null or remote_max_message_length >= 0);

comment on column public.support_cases.remote_site_id is
  'Site remoto observado na conversa pós-venda; necessário para resolver o Agente de Mensageria correto no envio.';

comment on column public.support_cases.remote_max_message_length is
  'Limite de texto do vendedor retornado pela conversa pós-venda; 0 significa que não há capacidade declarada.';
