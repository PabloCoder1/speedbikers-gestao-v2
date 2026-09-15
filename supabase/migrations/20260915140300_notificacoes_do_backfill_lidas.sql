-- D-351 -- as notificacoes que o primeiro backfill de producao gerou passam a LIDAS.
--
-- Migration de DADOS, no precedente de D-222. Nao apaga nada: `notifications`,
-- `notification_recipients` e `domain_events` ficam como estao; so `read_at` e
-- preenchido. Decisao do dono (D-350 §6): marcar como lidas.
--
-- O RECORTE e o join `domain_events.occurred_at < ml_accounts.connected_at`: um evento
-- sobre algo que aconteceu antes de a conta ser conectada so pode ter vindo da carga da
-- historia. Medido em producao antes de aplicar (so SELECT):
--
--   recorte                          32.258 destinatarios, todos nao lidos, todos
--                                    `order.cancelled` com source `sync`, notificacoes
--                                    criadas entre 17:31:22 e 18:25:36 de 2026-09-14
--   posteriores a conexao, nao lidos  5.049 em 2026-09-15 (54 as 17:30 e 19 as 19:20
--                                    UTC de 09-14) -- ficam nao lidos
--   eventos sem conta                     0
--
-- DUAS ANCORAS a mais, que nao mudam o recorte medido (32.258 com e sem elas):
-- `event_type = 'order.cancelled'` e a notificacao criada antes de 2026-09-14 18:30 UTC
-- (o backfill terminou as 18:25). `connected_at` e reescrito a cada reconexao
-- (`apps/api/src/ml-accounts.ts`): se uma conta reconectar antes de esta migration ser
-- aplicada, "evento anterior a conexao" passaria a incluir noticias reais -- devolucao,
-- disputa, cancelamento de hoje -- e elas sairiam como lidas. As ancoras prendem o
-- recorte ao que o backfill gerou (revisao de D-351, BAIXA-1).
--
-- Por que nao a janela de horario da carga sozinha (17:31 a 18:26): ela tinha 19
-- notificacoes reais dentro. E por que nao "marcar todas" pela tela: leva as legitimas.
--
-- NO DEV o recorte mede 0 (medido no mesmo dia): nao faz nada. Num banco novo, a
-- migration roda antes de haver dado: nao faz nada. Idempotente: so toca `read_at` nulo.
update public.notification_recipients r
   set read_at = now()
  from public.notifications n
  join public.domain_events e on e.id = n.domain_event_id
  join public.ml_accounts a on a.id = e.ml_account_id
 where n.id = r.notification_id
   and r.read_at is null
   and e.event_type = 'order.cancelled'
   and n.created_at < timestamptz '2026-09-14 18:30:00+00'
   and e.occurred_at < a.connected_at;
