-- Terceira rodada da auditoria de GRANTs (D-066, D-098) -- e desta vez com um
-- argumento de peso diferente das anteriores.
--
-- PARTE A -- as duas tabelas que o TESTE-GUARDA de D-098 ja acusa.
--
-- Medido contra o `pg_default_acl` real: o schema `public` deste projeto
-- concede `arwdDxtm` -- tudo, inclusive INSERT/UPDATE/DELETE/TRUNCATE -- a
-- `authenticated` em toda tabela criada pelo papel `postgres`. Um
-- `grant select` explicito na migration NAO desfaz isso: GRANTs sao aditivos.
-- Isso confirma no nivel do catalogo o achado empirico de D-062/D-066 e
-- refuta o comentario de 20260825170000 ("Supabase 2026 nao expoe tabela nova
-- por default").
--
--   * `profiles` (20260820150000) -- tem policy de SELECT e de UPDATE, e a
--     linha nasce de um TRIGGER sobre `auth.users`, que roda como dono da
--     funcao, nao como `authenticated`. INSERT e DELETE nunca foram usados
--     por ninguem (o unico `upsert` do repo esta no seed de e2e, que usa
--     `service_role`). D-066 excluiu a tabela da rodada 1 por ela "ter policy
--     de escrita legitima" -- verdade para UPDATE, e so para ele.
--   * `sku_listing_link_events` (20260828191841, D-125) -- append-only, com
--     policy de SELECT apenas; a escrita legitima e do `service_role` pelas
--     RPCs. Revoguei de `anon` e esqueci de `authenticated` -- exatamente o
--     erro que o comentario de D-098 descreve, cometido no dia seguinte.
--
-- Nenhuma das duas esteve exposta: sem policy correspondente a RLS nega, e em
-- `sku_listing_link_events` o trigger append-only recusaria UPDATE/DELETE de
-- todo jeito. Mas o guarda mede o INVARIANTE, nao a exposicao -- e por isso
-- a CI esta vermelha.

revoke insert, update, delete on public.profiles from authenticated;
revoke insert, update, delete on public.sku_listing_link_events from authenticated;

-- PARTE B -- TRUNCATE, onde o argumento das rodadas anteriores NAO se sustenta.
--
-- D-066 e D-098 se tranquilizaram com "a RLS nega de qualquer jeito, entao e
-- superficie morta". Para TRUNCATE isso e FALSO: TRUNCATE nao consulta policy
-- nenhuma. A RLS nao e rede de seguranca aqui, e os triggers append-only de
-- `domain_events` e `stock_movements` tambem nao disparam em TRUNCATE.
--
-- Medido: 33 das 54 tabelas de `public` ainda davam TRUNCATE a
-- `authenticated` -- entre elas `orders`, `order_items`, `skus`, `listings`,
-- `stock_movements` e `domain_events`. As outras 21 nasceram depois da
-- convencao de D-062 (`revoke all ... from anon, authenticated` na criacao) e
-- ja estavam limpas.
--
-- Nao ha caminho conhecido de exploracao hoje: o PostgREST nao expoe
-- TRUNCATE. O motivo de remover assim mesmo e que este e o unico privilegio
-- de escrita em que "ninguem alcanca" seria a UNICA coisa entre o dado e o
-- apagamento total -- sem policy, sem trigger, sem `where`.
--
-- Lista explicita e nao bloco dinamico, pelo mesmo motivo de D-066: o que a
-- migration faz tem de ser legivel na revisao. Tabela criada DEPOIS desta
-- precisa do seu proprio revoke, e o teste-guarda estendido em D-130 cobra.

revoke truncate on
  public.ai_runs,
  public.daily_listing_visits,
  public.document_items,
  public.documents,
  public.domain_events,
  public.erp_import_batches,
  public.erp_import_rows,
  public.erp_stock_snapshots,
  public.feature_suggestions,
  public.fulfillment_stock_snapshots,
  public.inventory_balances,
  public.link_candidates,
  public.listings,
  public.ml_accounts,
  public.notification_preferences,
  public.notification_recipients,
  public.notifications,
  public.order_items,
  public.orders,
  public.organization_members,
  public.organizations,
  public.profiles,
  public.purchase_order_events,
  public.purchase_order_items,
  public.purchase_orders,
  public.sku_components,
  public.sku_listing_link_events,
  public.skus,
  public.stock_movements,
  public.suppliers,
  public.sync_errors,
  public.sync_runs,
  public.user_account_permissions
from authenticated;
