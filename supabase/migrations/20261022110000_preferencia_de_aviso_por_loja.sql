-- ============================================================
-- C-82 (D-635) -- a loja da Shopee na preferencia de aviso.
--
-- `notification_preferences` so conhecia a conta do ML. O aviso em tempo real
-- (`apps/web/lib/notification-preferences.ts`, o unico lugar que ainda decide
-- pela preferencia, D-076) ja recebe o `shopee_shop_id` do evento (D-638),
-- mas nao havia como dizer "desta loja, so o critico".
--
-- 1. `shopee_shop_id`, com a mesma regra de origem do `domain_events`
--    (`domain_events_uma_origem`): conta OU loja, nunca as duas na mesma
--    linha. Apagar a loja apaga a preferencia dela, como a conta.
-- 2. A unicidade por escopo, agora com a loja: a regra geral e a regra so de
--    tipo passam a exigir loja nula, e a loja ganha os seus dois escopos
--    (so a loja; tipo e loja), espelho dos da conta.
-- 3. A RLS: a mesma politica de antes (cada um ve e grava a sua) e, na
--    gravacao, so loja que o usuario alcanca (`private.accessible_shopee_shops`).
--    A linha de antes, sem loja, passa igual.
-- 4. `get_settings_overview`: a "regra geral" do resumo de configuracoes
--    passa a exigir loja nula -- a regra so de loja nao e a geral.
-- ============================================================

alter table public.notification_preferences
  add column shopee_shop_id uuid references public.shopee_shops(id) on delete cascade;

alter table public.notification_preferences
  add constraint notification_preferences_uma_origem
  check (ml_account_id is null or shopee_shop_id is null);

comment on column public.notification_preferences.shopee_shop_id is
  'C-82: a loja da Shopee da regra (conta do ML OU loja, nunca as duas). Nula = a regra nao escolhe loja.';

-- As duas regras sem conta passam a ser tambem sem loja.
drop index public.notification_preferences_unique_both_null;
create unique index notification_preferences_unique_both_null
  on public.notification_preferences (user_id)
  where event_type is null and ml_account_id is null and shopee_shop_id is null;

drop index public.notification_preferences_unique_event_only;
create unique index notification_preferences_unique_event_only
  on public.notification_preferences (user_id, event_type)
  where event_type is not null and ml_account_id is null and shopee_shop_id is null;

-- Os dois escopos da loja, espelho dos da conta.
create unique index notification_preferences_unique_shop_only
  on public.notification_preferences (user_id, shopee_shop_id)
  where event_type is null and shopee_shop_id is not null;

create unique index notification_preferences_unique_event_and_shop
  on public.notification_preferences (user_id, event_type, shopee_shop_id)
  where event_type is not null and shopee_shop_id is not null;

-- A FK nova pede o indice da loja (apagar a loja procura as preferencias dela).
create index notification_preferences_shopee_shop_idx
  on public.notification_preferences (shopee_shop_id)
  where shopee_shop_id is not null;

drop policy notification_preferences_all_own on public.notification_preferences;
create policy notification_preferences_all_own on public.notification_preferences
  for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (shopee_shop_id is null or shopee_shop_id in (select private.accessible_shopee_shops()))
  );

CREATE OR REPLACE FUNCTION public.get_settings_overview(p_organization_id uuid)
 RETURNS TABLE(organization_name text, organization_slug text, members_total bigint, members_admin bigint, replenishment_default bigint, replenishment_brand bigint, replenishment_sku bigint, notification_prefs_mine bigint, notification_global_min_severity text, notification_global_enabled boolean, saved_filters_mine bigint, reply_templates bigint, knowledge_entries bigint, knowledge_validated bigint, ml_accounts_total bigint, ml_accounts_connected bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select
    (select o.name from public.organizations o where o.id = p_organization_id),
    (select o.slug from public.organizations o where o.id = p_organization_id),
    (select count(*) from public.organization_members m where m.organization_id = p_organization_id),
    (select count(*) from public.organization_members m where m.organization_id = p_organization_id and m.role = 'ADMIN'),
    -- D-144: tres escopos, o mais especifico vence. "Padrao da organizacao" e
    -- a linha sem marca e sem SKU; sem ela, a sugestao de compra recusa numero
    -- para tudo que nao tiver regra propria.
    (select count(*) from public.replenishment_settings r where r.organization_id = p_organization_id and r.supplier_brand is null and r.sku_id is null),
    (select count(*) from public.replenishment_settings r where r.organization_id = p_organization_id and r.supplier_brand is not null),
    (select count(*) from public.replenishment_settings r where r.organization_id = p_organization_id and r.sku_id is not null),
    -- Por usuario (RLS): as MINHAS preferencias, e a regra geral (curinga sem
    -- tipo e sem conta) se eu tiver uma.
    (select count(*) from public.notification_preferences n where n.user_id = (select auth.uid())),
    -- C-82: a regra geral e sem tipo, sem conta E sem loja.
    (select n.min_severity from public.notification_preferences n where n.user_id = (select auth.uid()) and n.event_type is null and n.ml_account_id is null and n.shopee_shop_id is null limit 1),
    (select n.enabled from public.notification_preferences n where n.user_id = (select auth.uid()) and n.event_type is null and n.ml_account_id is null and n.shopee_shop_id is null limit 1),
    (select count(*) from public.saved_filters f where f.organization_id = p_organization_id and f.created_by = (select auth.uid())),
    (select count(*) from public.reply_templates t where t.organization_id = p_organization_id),
    (select count(*) from public.knowledge_entries k where k.organization_id = p_organization_id),
    (select count(*) from public.knowledge_entries k where k.organization_id = p_organization_id and k.status = 'VALIDADO'),
    (select count(*) from public.ml_accounts a where a.organization_id = p_organization_id),
    (select count(*) from public.ml_accounts a where a.organization_id = p_organization_id and a.status = 'CONNECTED')
$function$;
