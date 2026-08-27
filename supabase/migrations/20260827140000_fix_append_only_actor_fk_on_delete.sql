-- Correção do defeito latente de D-094, e do gêmeo dele achado em
-- 2026-08-27 (D-099): `support_case_events.actor_user_id` e
-- `purchase_order_events.actor_user_id` eram `on delete set null` em
-- tabelas APPEND-ONLY — e um SET NULL é um UPDATE disparado pela própria
-- FK, que o trigger de append-only de cada tabela recusa. Consequência:
-- deletar um usuário que já triou um atendimento (ou transicionou um
-- pedido de compra) falhava com a mensagem ENGANOSA de append-only
-- ("Insira um novo evento."), em vez de dizer que o usuário está
-- referenciado.
--
-- A armadilha já estava documentada no projeto desde 2026-08-21, no
-- comentário de `stock_movements.created_by` (20260821200000, linhas
-- 75-82), e o precedente é unânime nas quatro colunas de ator que a
-- evitaram: `stock_movements.created_by`, `purchase_order_items.created_by`,
-- `action_decisions.created_by` e `support_reply_attempts.requested_by`
-- (esta última citando D-094 nominalmente) — todas `on delete restrict`.
--
-- `restrict` NÃO torna o usuário removível — o bloqueio continua, como em
-- `stock_movements` (linha de auditoria não sobrevive sem o ator). O que
-- muda é o erro: "violates foreign key constraint", diagnóstico correto,
-- em vez do erro de append-only que apontava para o lugar errado. A
-- alternativa (linha de auditoria sem FK, como `domain_events`, que não
-- referencia usuário) reescreveria o contrato das duas tabelas — mudança
-- maior que a dor, rejeitada pelo mesmo raciocínio incremental de sempre.
--
-- ADD CONSTRAINT revalida as linhas existentes — inofensivo: toda linha
-- tem ator válido ou null, e o RESTRICT só atua em DELETEs futuros.

alter table public.support_case_events
  drop constraint support_case_events_actor_user_id_fkey,
  add constraint support_case_events_actor_user_id_fkey
    foreign key (actor_user_id) references public.profiles(id) on delete restrict;

alter table public.purchase_order_events
  drop constraint purchase_order_events_actor_user_id_fkey,
  add constraint purchase_order_events_actor_user_id_fkey
    foreign key (actor_user_id) references public.profiles(id) on delete restrict;
