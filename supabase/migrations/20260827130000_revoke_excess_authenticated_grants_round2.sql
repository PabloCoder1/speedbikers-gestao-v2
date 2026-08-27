-- Segunda rodada da auditoria de GRANTs (D-098) — o mesmo aperto de
-- superfície de D-066 (20260824132723), para as tabelas criadas DEPOIS
-- dele que não seguiram a convenção de D-062 (revogar de `authenticated`
-- na criação): `notifications`, `notification_recipients`, `ai_runs` e
-- `feature_suggestions`. As sete tabelas de support (20260825170000,
-- 20260826140000) já nasceram com revoke explícito e ficam de fora;
-- `notification_preferences` fica de fora porque o CRUD completo é
-- intencional (policy `notification_preferences_all_own`).
--
-- Mesmo raciocínio de D-066: privilégios padrão deste projeto Supabase
-- concedem INSERT/UPDATE/DELETE a `authenticated` em tabela nova, e um
-- `grant select` explícito na migration NÃO desfaz isso — GRANTs são
-- aditivos. A RLS nega a escrita sem policy correspondente (por isso é
-- aperto de superfície, não correção de vazamento), mas a superfície não
-- deveria existir. Obs.: a migration 20260825170000 afirma em comentário
-- que "Supabase 2026 não expõe tabela nova por default" — o oposto do
-- achado MEDIDO de D-062/D-066; na dúvida, o revoke abaixo é idempotente
-- (revogar o que não foi concedido é no-op), e o teste-guarda novo em
-- packages/db/src/rls.integration.test.ts passa a decidir a questão
-- empiricamente contra Postgres real a cada execução da CI.
--
-- O que cada tabela MANTÉM (intencional, coberto por policy):
--   notifications            -> nada de escrita (trigger escreve via dono)
--   notification_recipients  -> UPDATE (marcar lida, policy _update_own)
--   ai_runs                  -> nada de escrita (api grava via service_role)
--   feature_suggestions      -> INSERT (policy _insert_own) e UPDATE
--                               (policy _update_admin); DELETE não tem
--                               policy e por isso sai.

revoke insert, update, delete on public.notifications from authenticated;
revoke insert, delete on public.notification_recipients from authenticated;
revoke insert, update, delete on public.ai_runs from authenticated;
revoke delete on public.feature_suggestions from authenticated;
