-- ============================================================
-- Vínculo humano de item de NF-e a SKU (Fase 4, docs/ROADMAP.md;
-- docs/NFE.md secao 3) — tela de conferência.
--
-- Mesmo padrão de resolve_link_candidate/dismiss_link_candidate
-- (20260821000000_create_link_candidates.sql): Server Action chama a RPC,
-- nunca escreve em document_items direto (grant de authenticated é só
-- SELECT, docs/ARCHITECTURE.md secao 4 já lista "confirmar vínculo" como
-- exemplo de Server Action). Autorização refeita AQUI DENTRO pelo mesmo
-- motivo já documentado lá: security definer ignora GRANT e RLS.
--
-- Uma função só, não duas: vincular e desvincular são a MESMA operação
-- (document_items não tem estado OPEN/RESOLVED por item, só sku_id
-- nulo-ou-não) — p_sku_id null desfaz um vínculo errado antes da aplicação.
-- ============================================================

create or replace function public.link_document_item(p_item_id bigint, p_sku_id uuid default null)
returns public.document_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.document_items;
  doc public.documents;
  target_org uuid;
  result public.document_items;
  new_resolved integer;
begin
  select * into item from public.document_items where id = p_item_id for update;

  if item.id is null then
    raise exception 'item % nao encontrado', p_item_id;
  end if;

  select * into doc from public.documents where id = item.document_id for update;

  if doc.status <> 'PARSED' then
    raise exception 'documento % nao esta em conferencia (status %)', doc.id, doc.status;
  end if;

  if not private.is_member_of(doc.organization_id) or not private.has_role(array['ADMIN', 'GESTOR']) then
    raise exception 'sem permissao para vincular este item';
  end if;

  if p_sku_id is not null then
    select organization_id into target_org from public.skus where id = p_sku_id;

    if target_org is distinct from doc.organization_id then
      raise exception 'SKU pertence a outra organizacao';
    end if;
  end if;

  update public.document_items set sku_id = p_sku_id where id = p_item_id
    returning * into result;

  select count(*) into new_resolved
    from public.document_items
    where document_id = doc.id and sku_id is not null;

  update public.documents set resolved_items = new_resolved where id = doc.id;

  return result;
end;
$$;

comment on function public.link_document_item is
  'Confirmacao humana: vincula (ou desvincula, p_sku_id null) um item da NF-e a um SKU e recalcula documents.resolved_items.';

-- `revoke ... from public` NÃO basta: este projeto tem `alter default
-- privileges` concedendo EXECUTE a `anon` em toda função nova do schema
-- public (achado pelo advisor de segurança após aplicar esta migration no
-- Dev, 2026-08-22) — revogar de PUBLIC não remove esse grant default
-- separado. `anon` é revogado explicitamente por segurança, mesmo a função
-- já recusando internamente quem não é ADMIN/GESTOR.
revoke all on function public.link_document_item(bigint, uuid) from public, anon;

grant execute on function public.link_document_item(bigint, uuid) to authenticated;
