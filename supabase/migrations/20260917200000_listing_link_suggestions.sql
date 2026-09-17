-- ============================================================
-- O popup de vincular sugere o SKU (D-374).
--
-- Pedido do dono em /vinculacoes: vincular mais facil, num popup, sem a tela
-- rolar ate o formulario. O que torna o popup RAPIDO de usar nao e so nao
-- rolar: e ele ja abrir com o SKU certo na mao.
--
-- ------------------------------------------------------------
-- DE ONDE VEM A SUGESTAO -- medido, nao suposto (Dev, authenticated)
-- ------------------------------------------------------------
-- Nao existe tabela de variacao nem SKU do vendedor em `listings` (o sync le
-- o anuncio, nao `variations[]`). Mas cada item de pedido guarda o
-- `seller_sku` que o vendedor digitou no ML e a `variation_id` vendida.
-- Dos 867 anuncios sem vinculo (90 dias), 587 tem `seller_sku` nos pedidos e
-- **505 tem `seller_sku` que bate EXATAMENTE com um `sku_key` do catalogo**.
--
-- A agregacao e do banco (a regra da casa): o anuncio mais vendido do Dev tem
-- 5.843 itens de pedido, que o navegador teria de baixar para deduplicar.
-- Pelo indice `order_items_listing_idx (ml_account_id, item_id, variation_id)`
-- a leitura agregada leva 14-18 ms.
--
-- ------------------------------------------------------------
-- O QUE DEVOLVE
-- ------------------------------------------------------------
--   variacoes  uma linha por (variation_id, seller_sku) vista nos pedidos:
--              pedidos, unidades, ultimo pedido, o titulo mais recente, e o
--              SKU do catalogo quando `seller_sku` bate com `sku_key` (mesma
--              normalizacao da coluna gerada: upper(btrim())). Ordenadas por
--              unidades: a variacao que mais vende primeiro.
--   vinculos   os vinculos que JA existem para o anuncio (inteiro ou por
--              variacao), para o popup nao oferecer o que a RPC recusaria
--              ("mistura de formas", D-125).
--
-- So leitura, security invoker: a RLS de `order_items`, `skus` e
-- `sku_listing_links` decide. Nao altera nenhuma funcao de vinculo.
-- ============================================================

create function public.get_listing_link_suggestions(
  p_ml_account_id uuid,
  p_item_id text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with itens as (
    select oi.organization_id, oi.variation_id,
           nullif(upper(btrim(oi.seller_sku)), '') as chave,
           nullif(btrim(oi.seller_sku), '') as seller_sku,
           oi.quantity, oi.order_id, oi.created_at, oi.title
    from public.order_items oi
    where oi.ml_account_id = p_ml_account_id
      and oi.item_id = upper(btrim(p_item_id))
  ),
  por_variacao as (
    select i.variation_id,
           i.chave,
           min(i.seller_sku) as seller_sku,
           count(distinct i.order_id)::bigint as pedidos,
           coalesce(sum(i.quantity), 0)::bigint as unidades,
           max(i.created_at) as ultimo_pedido_em,
           (array_agg(i.title order by i.created_at desc))[1] as titulo,
           min(i.organization_id::text)::uuid as organization_id
    from itens i
    group by i.variation_id, i.chave
  )
  select jsonb_build_object(
    'variacoes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'variation_id', v.variation_id,
               'seller_sku', v.seller_sku,
               'pedidos', v.pedidos,
               'unidades', v.unidades,
               'ultimo_pedido_em', v.ultimo_pedido_em,
               'titulo', v.titulo,
               'sku_id', k.id,
               'sku', k.sku,
               'sku_title', k.title)
             order by v.unidades desc, v.ultimo_pedido_em desc)
      from por_variacao v
      left join public.skus k
        on k.organization_id = v.organization_id
       and v.chave is not null
       and k.sku_key = v.chave), '[]'::jsonb),
    'vinculos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'link_id', l.id,
               'variation_id', l.variation_id,
               'sku_id', l.sku_id,
               'sku', k.sku)
             order by l.variation_id nulls first)
      from public.sku_listing_links l
      left join public.skus k on k.id = l.sku_id
      where l.ml_account_id = p_ml_account_id
        and l.item_id = upper(btrim(p_item_id))), '[]'::jsonb)
  )
$$;

comment on function public.get_listing_link_suggestions(uuid, text) is
  'Sugestao de SKU para o popup de vincular de /vinculacoes (D-374): agrega os itens de pedido do anuncio por (variation_id, seller_sku) -- pedidos, unidades, ultimo pedido, titulo mais recente -- e cruza seller_sku com skus.sku_key (upper(btrim)). Devolve tambem os vinculos ja existentes do anuncio, para a tela nao oferecer mistura de formas (D-125). So leitura, security invoker; usa order_items_listing_idx.';

revoke all on function public.get_listing_link_suggestions(uuid, text) from public, anon;
grant execute on function public.get_listing_link_suggestions(uuid, text) to authenticated, service_role;
