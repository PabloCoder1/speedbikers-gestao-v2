create function public.search_entities(
  p_organization_id uuid,
  p_query text
)
returns table (
  entity_type text,
  label text,
  sublabel text,
  href text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select trim(p_query) as term
  )
  (
    select 'sku' as entity_type, sk.sku as label, coalesce(sk.title, '') as sublabel, '/skus/' || sk.id::text as href
    from public.skus sk, q
    where sk.organization_id = p_organization_id
      and q.term <> ''
      and (sk.sku ilike '%' || q.term || '%' or sk.title ilike '%' || q.term || '%')
    order by sk.sku
    limit 5
  )
  union all
  (
    select 'anuncio', l.title, l.item_id, '/anuncios'
    from public.listings l, q
    where l.organization_id = p_organization_id
      and q.term <> ''
      and (l.title ilike '%' || q.term || '%' or l.item_id ilike '%' || q.term || '%')
    order by l.title
    limit 5
  )
  union all
  (
    select 'conta', ma.label, ma.slug, '/contas'
    from public.ml_accounts ma, q
    where ma.organization_id = p_organization_id
      and q.term <> ''
      and (ma.label ilike '%' || q.term || '%' or ma.slug ilike '%' || q.term || '%')
    order by ma.label
    limit 5
  )
  union all
  (
    select 'fornecedor', s.name, coalesce(s.document, ''), '/fornecedores'
    from public.suppliers s, q
    where s.organization_id = p_organization_id
      and q.term <> ''
      and (s.name ilike '%' || q.term || '%' or s.document ilike '%' || q.term || '%')
    order by s.name
    limit 5
  )
  union all
  (
    select 'pedido_compra', 'Pedido #' || po.order_number::text, po.status, '/compras/' || po.id::text
    from public.purchase_orders po, q
    where po.organization_id = p_organization_id
      and q.term <> ''
      and po.order_number::text ilike '%' || q.term || '%'
    order by po.order_number
    limit 5
  )
$$;

comment on function public.search_entities(uuid, text) is
  'Busca universal / Command Palette (Fase 5B, docs/PRODUCT_REQUIREMENTS.md secao "Busca universal") — UNION ALL de cinco entidades com destino de navegação REAL hoje: sku (-> /skus/{id}), anuncio/listing (-> /anuncios, sem pagina por item ainda), conta ML (-> /contas), fornecedor (-> /fornecedores), pedido de compra (-> /compras/{id}). "Filtros salvos" (mesma linha do checklist original) e "ação"/Central de Ações (Fase 6/7, ainda nao existe) ficam de fora desta fatia — ver decisao. Pedido de VENDA do Mercado Livre tambem fica de fora: nao existe pagina de detalhe de pedido na V3 hoje (/vendas e dashboard agregado, nao lista por pedido), entao nao ha para onde levar o resultado. security invoker: RLS de cada tabela ja filtra, organization_id aqui e so a mesma pre-filtragem explicita usada nos outros RPCs desta sessao.';

revoke all on function public.search_entities(uuid, text) from public, anon;
grant execute on function public.search_entities(uuid, text) to authenticated, service_role;
