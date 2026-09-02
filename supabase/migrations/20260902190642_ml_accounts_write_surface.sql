-- ============================================================
-- ml_accounts: a superficie de escrita do navegador encolhe para o unico
-- verbo que tem consumidor (item do P0 da trilha 8B, aberto por D-182).
--
-- O QUE FOI MEDIDO ANTES DE ESCREVER, no catalogo e no codigo:
--
--   * "authenticated" tem INSERT, UPDATE, DELETE e SELECT na tabela;
--   * a policy "ml_accounts_admin_writes" e "for ALL", com o predicado
--     has_org_role(organization_id, ARRAY['ADMIN']) no USING e no CHECK;
--   * das tres escritas, SO O INSERT TEM CONSUMIDOR:
--       - INSERT: apps/web/app/contas/actions.ts (Server Action, sob RLS,
--         D-012) — legitimo, e continua valendo;
--       - UPDATE: apps/api/src/ml-accounts.ts, apps/worker/.../ml-token.ts e
--         backfill-orders.ts — todos AdminClient (service_role);
--       - DELETE: NENHUM, em nenhum dos tres apps. So os testes de
--         integracao e a seed do e2e, e os dois usam service_role.
--
-- POR QUE O DELETE E O ITEM PERIGOSO, e nao so excesso de privilegio:
-- ml_credentials e blindada em TRES camadas independentes (zero grant para
-- authenticated/anon, RLS ligada, zero policies) porque guarda os tokens do
-- Mercado Livre cifrados. O CASCADE ATRAVESSA AS TRES, porque roda com os
-- privilegios do dono da tabela, nao com os do chamador. Sao 7 filhas em
-- CASCADE, e duas doem: ml_credentials (segredo vivo) e sku_listing_links
-- (vinculo confirmado por gente, D-119/D-125).
--
-- As outras 15 filhas sao RESTRICT, o que torna o DELETE impossivel para
-- qualquer conta com historico (pedidos, sync_runs, domain_events...). ISSO
-- NAO E A DEFESA — e o motivo de o furo nunca ter aparecido: a conta que o
-- DELETE alcanca e justamente a recem-criada ou a que falhou no OAuth, que ja
-- tem credencial gravada e ainda nao tem historico.
--
-- DUAS CAMADAS, como a casa faz desde D-066/D-098/D-130: o GRANT some (o
-- navegador apanha antes de chegar na RLS) e a POLICY encolhe para "insert"
-- (se o grant voltar por descuido, a RLS ainda recusa).
--
-- A policy de SELECT nao muda e nao perde nada: ml_accounts_select_permitted
-- usa accessible_accounts(), que da ao ADMIN TODAS as contas da organizacao —
-- conferido no catalogo, e mais larga que o predicado da "ALL" que sai. Esta
-- era uma das 4 policies que D-182 catalogou como "redundantes, nao
-- vazamento"; agora ela deixa de ser redundante e passa a ser especifica.
-- ============================================================

revoke update, delete on public.ml_accounts from authenticated;

drop policy ml_accounts_admin_writes on public.ml_accounts;

create policy ml_accounts_admin_inserts on public.ml_accounts
  for insert
  to authenticated
  with check (private.has_org_role(organization_id, array['ADMIN']));

comment on policy ml_accounts_admin_inserts on public.ml_accounts is
  'Criar conta e a UNICA escrita do navegador em ml_accounts (apps/web/app/contas/actions.ts). UPDATE roda como service_role na api/worker; DELETE nao tem consumidor em lugar nenhum e cascatearia em ml_credentials, que e blindada contra acesso direto.';
