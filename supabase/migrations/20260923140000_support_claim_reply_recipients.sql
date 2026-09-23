-- Destinos de resposta que o Mercado Livre liberou para um claim na última
-- sincronização. A escolha é do operador; esta coluna só impede oferecer um
-- destinatário que a API remota não permite naquele estado.

alter table public.support_cases
  add column remote_reply_recipient_roles text[] not null default '{}'::text[]
  check (remote_reply_recipient_roles <@ array['complainant', 'mediator']::text[]);

comment on column public.support_cases.remote_reply_recipient_roles is
  'Papéis de destinatário permitidos pelo Mercado Livre na última leitura do claim; enviar exige nova validação remota.';
