-- ============================================================
-- `has_role` passa a exigir ORGANIZACAO (D-180, P0-D da trilha 8B).
--
-- `private.has_role(allowed text[])` responde "sou X em ALGUMA organizacao",
-- sem receber qual. As policies o combinavam com `is_member_of(org)`, mas os
-- dois sao EXISTS INDEPENDENTES sobre a mesma tabela: quem for ADMIN na
-- organizacao A e membro qualquer na B satisfaz os dois para as linhas da B —
-- e ganha poder de ADMIN na B.
--
-- Inventario medido em 2026-09-01 no Dev: **21 policies** (19 em `using`,
-- 9 em `with check`) sobre 16 tabelas, e **8 funcoes**. Sete das funcoes ja
-- checavam `is_member_of` da organizacao certa junto — nelas o furo exige
-- ser membro da organizacao alvo E ter papel em outra. A oitava,
-- `triage_support_case`, chamava `has_role` **sem nenhuma checagem de
-- organizacao**: bastava ter acesso a conta (que um VISUALIZADOR da
-- organizacao dona pode ter) e ser OPERADOR em qualquer outra.
--
-- Hoje existe UMA organizacao e UM usuario, entao nada disso e explorável
-- agora. O item de Administracao de Usuarios (D-175) existe justamente para
-- destravar a entrada da segunda pessoa — e este furo tinha que fechar
-- ANTES disso, nao depois.
--
-- A prova de que nada ficou para tras esta no fim: `drop function
-- private.has_role` falha se qualquer policy ou funcao ainda depender dela,
-- e a migration inteira reverte.
-- ============================================================

-- ------------------------------------------------------------
-- 1. O predicado com escopo
-- ------------------------------------------------------------
create function private.has_org_role(target_org uuid, allowed text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Papel e organizacao na MESMA linha. E essa juncao — e nao a conjuncao de
  -- dois EXISTS separados — que fecha o escopo.
  select exists (
    select 1
    from public.organization_members m
    where m.user_id = (select auth.uid())
      and m.organization_id = target_org
      and m.role = any (allowed)
  );
$$;

comment on function private.has_org_role(uuid, text[]) is
  'Verdadeiro quando o chamador tem um dos papeis NA organizacao indicada (D-180). Substitui o par `is_member_of(org) and has_role(papeis)`, que eram dois EXISTS independentes e deixavam o papel de uma organizacao valer em outra.';

-- ------------------------------------------------------------
-- 2. As 21 policies
-- ------------------------------------------------------------
drop policy ai_runs_select_own_or_admin on public.ai_runs;
create policy ai_runs_select_own_or_admin on public.ai_runs for select to authenticated
  using (((user_id = ( SELECT auth.uid() AS uid)) OR (private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text]))));

drop policy document_items_select_admin on public.document_items;
create policy document_items_select_admin on public.document_items for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM public.documents d
  WHERE ((d.id = document_items.document_id) AND private.has_org_role(d.organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])))));

drop policy documents_select_admin on public.documents;
create policy documents_select_admin on public.documents for select to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy erp_import_batches_select_admin on public.erp_import_batches;
create policy erp_import_batches_select_admin on public.erp_import_batches for select to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy erp_import_rows_select_admin on public.erp_import_rows;
create policy erp_import_rows_select_admin on public.erp_import_rows for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM public.erp_import_batches b
  WHERE ((b.id = erp_import_rows.batch_id) AND private.has_org_role(b.organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])))));

drop policy erp_stock_snapshots_select_admin on public.erp_stock_snapshots;
create policy erp_stock_snapshots_select_admin on public.erp_stock_snapshots for select to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy feature_suggestions_update_admin on public.feature_suggestions;
create policy feature_suggestions_update_admin on public.feature_suggestions for update to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])))
  with check ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy knowledge_entries_update_admin on public.knowledge_entries;
create policy knowledge_entries_update_admin on public.knowledge_entries for update to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])))
  with check ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy ml_accounts_admin_writes on public.ml_accounts;
create policy ml_accounts_admin_writes on public.ml_accounts for all to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text])))
  with check ((private.has_org_role(organization_id, ARRAY['ADMIN'::text])));

drop policy organization_members_admin_writes on public.organization_members;
create policy organization_members_admin_writes on public.organization_members for all to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text])))
  with check ((private.has_org_role(organization_id, ARRAY['ADMIN'::text])));

drop policy purchase_order_events_select_permitted on public.purchase_order_events;
create policy purchase_order_events_select_permitted on public.purchase_order_events for select to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy purchase_order_items_select_permitted on public.purchase_order_items;
create policy purchase_order_items_select_permitted on public.purchase_order_items for select to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy purchase_orders_select_permitted on public.purchase_orders;
create policy purchase_orders_select_permitted on public.purchase_orders for select to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy replenishment_settings_delete_admin on public.replenishment_settings;
create policy replenishment_settings_delete_admin on public.replenishment_settings for delete to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy replenishment_settings_insert_admin on public.replenishment_settings;
create policy replenishment_settings_insert_admin on public.replenishment_settings for insert to authenticated
  with check ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy replenishment_settings_update_admin on public.replenishment_settings;
create policy replenishment_settings_update_admin on public.replenishment_settings for update to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])))
  with check ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy reply_templates_delete_admin on public.reply_templates;
create policy reply_templates_delete_admin on public.reply_templates for delete to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy reply_templates_insert_admin on public.reply_templates;
create policy reply_templates_insert_admin on public.reply_templates for insert to authenticated
  with check ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text]) AND (created_by = ( SELECT auth.uid() AS uid))));

drop policy reply_templates_update_admin on public.reply_templates;
create policy reply_templates_update_admin on public.reply_templates for update to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])))
  with check ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy suppliers_select_permitted on public.suppliers;
create policy suppliers_select_permitted on public.suppliers for select to authenticated
  using ((private.has_org_role(organization_id, ARRAY['ADMIN'::text, 'GESTOR'::text])));

drop policy user_account_permissions_admin_writes on public.user_account_permissions;
create policy user_account_permissions_admin_writes on public.user_account_permissions for all to authenticated
  using ((EXISTS ( SELECT 1
   FROM public.ml_accounts a
  WHERE ((a.id = user_account_permissions.ml_account_id) AND private.has_org_role(a.organization_id, ARRAY['ADMIN'::text])))))
  with check ((EXISTS ( SELECT 1
   FROM public.ml_accounts a
  WHERE ((a.id = user_account_permissions.ml_account_id) AND private.has_org_role(a.organization_id, ARRAY['ADMIN'::text])))));

-- ------------------------------------------------------------
-- 3. As 8 funcoes
--
-- A troca e textual e uniforme, e cada substituicao e VERIFICADA: se o corpo
-- de alguma funcao mudar de forma no futuro e o padrao nao casar, a migration
-- levanta excecao em vez de deixar a funcao com o predicado antigo.
-- ------------------------------------------------------------
do $$
declare
  r record;
  novo text;
begin
  for r in
    select p.oid, n.nspname, p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prokind = 'f'
      and p.proname <> 'has_role'
      and pg_get_functiondef(p.oid) like '%has_role%'
  loop
    novo := r.def;

    -- Forma 1: guarda negativa com a organizacao ao lado.
    novo := replace(novo,
      'not private.is_member_of(p_organization_id)' || chr(10) || '     or not private.has_role(',
      'not private.has_org_role(p_organization_id, ');
    novo := replace(novo,
      'not private.is_member_of(p_organization_id) or not private.has_role(',
      'not private.has_org_role(p_organization_id, ');
    novo := replace(novo,
      'not private.is_member_of(doc.organization_id) or not private.has_role(',
      'not private.has_org_role(doc.organization_id, ');
    novo := replace(novo,
      'not private.is_member_of(candidate.organization_id)' || chr(10) || '     or not private.has_role(',
      'not private.has_org_role(candidate.organization_id, ');

    -- Forma 2: predicado positivo dentro de expressao booleana.
    novo := replace(novo,
      'private.is_member_of(organization_id) and private.has_role(',
      'private.has_org_role(organization_id, ');

    -- Forma 3: `triage_support_case` — nao tinha organizacao nenhuma ao lado
    -- do papel. A organizacao correta e a do proprio caso.
    novo := replace(novo,
      'if not private.has_role(array[''ADMIN'', ''GESTOR'', ''OPERADOR'']) then',
      'if not private.has_org_role(atual.organization_id, array[''ADMIN'', ''GESTOR'', ''OPERADOR'']) then');

    -- Forma 4: guarda de tres partes (organizacao + conta + papel), com o
    -- alias do registro carregado. `has_account_access` continua separado:
    -- ele valida a CONTA, que e outra dimensao do escopo.
    novo := replace(novo,
      'not private.is_member_of(c.organization_id)' || chr(10) ||
      '     or not private.has_account_access(c.ml_account_id)' || chr(10) ||
      '     or not private.has_role(',
      'not private.has_account_access(c.ml_account_id)' || chr(10) ||
      '     or not private.has_org_role(c.organization_id, ');
    novo := replace(novo,
      'not private.is_member_of(link.organization_id)' || chr(10) ||
      '     or not private.has_account_access(link.ml_account_id)' || chr(10) ||
      '     or not private.has_role(',
      'not private.has_account_access(link.ml_account_id)' || chr(10) ||
      '     or not private.has_org_role(link.organization_id, ');

    -- Forma 5: vinculo de anuncio — organizacao vem no proprio parametro.
    -- `has_account_access` PERMANECE: ele valida a conta, dimensao que
    -- `has_org_role` nao cobre. Trocar as duas por uma so afrouxaria o
    -- escopo em vez de fecha-lo.
    novo := replace(novo,
      'if not private.is_member_of(p_organization_id)' || chr(10) ||
      '     or not private.has_account_access(p_ml_account_id)' || chr(10) ||
      '     or not private.has_role(',
      'if not private.has_account_access(p_ml_account_id)' || chr(10) ||
      '     or not private.has_org_role(p_organization_id, ');

    if novo like '%has_role(array%' or novo like '%has_role(ARRAY%' then
      -- Sobrou chamada sem escopo: o padrao mudou e a substituicao cega
      -- deixaria o furo aberto. Melhor falhar a migration.
      if novo not like '%has_org_role%' or novo like '% private.has_role(%' then
        raise exception 'D-180: nao consegui migrar %.% — padrao de chamada nao reconhecido', r.nspname, r.proname;
      end if;
    end if;

    execute novo;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 4. A prova
--
-- Se qualquer policy ou funcao ainda depender de `has_role`, este DROP falha
-- e a migration inteira reverte — nao ha como o furo sobreviver em silencio.
-- ------------------------------------------------------------
drop function private.has_role(text[]);
