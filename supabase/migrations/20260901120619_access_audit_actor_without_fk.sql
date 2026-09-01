-- ============================================================
-- O ator da auditoria perde a FK, pela mesma razao que o alvo ja nao tinha
-- (D-175).
--
-- `actor_user_id ... on delete restrict` parecia o mais seguro — garante que
-- o ator existiu — mas numa tabela APPEND-ONLY ele significa outra coisa:
-- **ninguem pode ser removido do sistema depois de ter mexido em acesso**.
-- O `restrict` recusa apagar o `profiles`, e como a auditoria nao pode ser
-- editada nem apagada, nao existe saida. Foi o que a limpeza da suite
-- encontrou: "update or delete on table profiles violates foreign key
-- constraint organization_access_events_actor_user_id_fkey".
--
-- As tres opcoes eram: `restrict` (usuario indeletavel para sempre),
-- `set null` (o Postgres ESCREVE na tabela append-only — a contradicao de
-- D-149, ja corrigida em `ml_account_id` na migration anterior) ou SEM FK.
-- A terceira e a unica coerente com uma tabela que so cresce, e e o que
-- `target_user_id` ja fazia desde o inicio pelo mesmo motivo.
--
-- O que se perde: a garantia referencial de que o ator existe. O que se
-- ganha: poder desligar uma pessoa sem apagar a historia do que ela fez —
-- que e justamente o ponto de uma auditoria.
-- ============================================================

alter table public.organization_access_events
  drop constraint organization_access_events_actor_user_id_fkey;

comment on column public.organization_access_events.actor_user_id is
  'Quem fez a mudanca, de `auth.uid()`. NULO quando veio de service_role (seed/importacao/migration) — sem humano identificado, declara-se a ausencia em vez de inventar um. SEM FK de proposito: com `restrict` ninguem poderia ser removido do sistema depois de mexer em acesso, e com `set null` o Postgres escreveria numa tabela append-only (licao de D-149). O id e fato historico; a tela resolve o nome quando o perfil ainda existe.';
