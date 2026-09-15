-- D-351 -- as notificacoes que o primeiro backfill de producao gerou passam a LIDAS.
--
-- Migration de DADOS, no precedente de D-222. Nao apaga nada: `notifications`,
-- `notification_recipients` e `domain_events` ficam como estao; so `read_at` e
-- preenchido. Decisao do dono (D-350 §6): marcar como lidas.
--
-- O RECORTE e o join `domain_events.occurred_at < ml_accounts.connected_at`: um evento
-- sobre algo que aconteceu antes de a conta ser conectada so pode ter vindo da carga da
-- historia. Medido em producao em 2026-09-14, antes de aplicar:
--
--   recorte                          32.258 destinatarios, todos nao lidos, todos
--                                    `order.cancelled` com source `sync`, todos com o
--                                    evento gravado depois da conexao
--   posteriores a conexao, nao lidos     54 -- ficam nao lidos (eram 19 as 19:20 UTC)
--   eventos sem conta                     0
--
-- Por que nao a janela de horario da carga (17:31 a 18:26): ela tinha 19 notificacoes
-- reais dentro. E por que nao "marcar todas" pela tela: leva as legitimas junto.
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
   and e.occurred_at < a.connected_at;
