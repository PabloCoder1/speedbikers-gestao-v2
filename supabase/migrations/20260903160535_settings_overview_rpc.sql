-- ============================================================
-- `get_settings_overview` -- o Hub de Configuracoes (D-233).
--
-- O item "Administracao -> Configuracoes" do ROADMAP deixava uma decisao em
-- aberto: EMBUTIR as configuracoes num lugar so, ou APONTAR para a tela dona
-- de cada uma. A resposta e apontar (um dado, um dono, D-224), e esta funcao e
-- o que torna a landing util sem duplicar nada: ela responde "o que ja existe
-- e quanto" para cada secao, com TODAS as contagens feitas no banco, numa
-- chamada so (D-185: o custo e a viagem), sob a RLS de quem pergunta.
--
-- `security invoker` e o ponto: cada subselect e filtrado pelas policies que
-- ja existem. `notification_preferences` e `saved_filters` sao POR USUARIO
-- (policy `user_id = auth.uid()` / `created_by = auth.uid()`), entao os
-- campos `*_mine` sao "os meus", nao "os da organizacao" -- e isso e o que a
-- tela quer dizer. Para uma organizacao de que o chamador nao e membro, a RLS
-- esconde tudo: nome NULL e contagens ZERO, nao um erro (mesmo contrato de
-- `get_sku_dashboard`).
--
-- Sempre UMA linha (subselects escalares, sem group by), mesmo com tudo vazio:
-- a tela distingue "nao configurado" (contagem zero) de "indisponivel"
-- (leitura falhou), e nunca inventa zero.
--
-- Ensaiado no Dev em 2026-09-03 antes de aplicar, em transacao revertida:
-- os 16 campos batem com as contagens feitas a mao na mesma sessao.
-- ============================================================

create function public.get_settings_overview(p_organization_id uuid)
returns table (
  organization_name text,
  organization_slug text,
  members_total bigint,
  members_admin bigint,
  replenishment_default bigint,
  replenishment_brand bigint,
  replenishment_sku bigint,
  notification_prefs_mine bigint,
  notification_global_min_severity text,
  notification_global_enabled boolean,
  saved_filters_mine bigint,
  reply_templates bigint,
  knowledge_entries bigint,
  knowledge_validated bigint,
  ml_accounts_total bigint,
  ml_accounts_connected bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
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
    (select n.min_severity from public.notification_preferences n where n.user_id = (select auth.uid()) and n.event_type is null and n.ml_account_id is null limit 1),
    (select n.enabled from public.notification_preferences n where n.user_id = (select auth.uid()) and n.event_type is null and n.ml_account_id is null limit 1),
    (select count(*) from public.saved_filters f where f.organization_id = p_organization_id and f.created_by = (select auth.uid())),
    (select count(*) from public.reply_templates t where t.organization_id = p_organization_id),
    (select count(*) from public.knowledge_entries k where k.organization_id = p_organization_id),
    (select count(*) from public.knowledge_entries k where k.organization_id = p_organization_id and k.status = 'VALIDADO'),
    (select count(*) from public.ml_accounts a where a.organization_id = p_organization_id),
    (select count(*) from public.ml_accounts a where a.organization_id = p_organization_id and a.status = 'CONNECTED')
$$;

comment on function public.get_settings_overview(uuid) is
  'Visao geral do Hub de Configuracoes (D-233): o que existe e quanto, por secao, contado no banco numa chamada so e sob a RLS de quem pergunta. Campos *_mine sao do usuario (notification_preferences e saved_filters sao por usuario). Sempre uma linha; organizacao alheia devolve nome NULL e zeros, nao erro. security invoker.';

revoke all on function public.get_settings_overview(uuid) from public, anon;
grant execute on function public.get_settings_overview(uuid) to authenticated, service_role;
