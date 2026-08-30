-- Correlacao do diagnostico alcanca eventos de ANUNCIO e PEDIDO (D-152,
-- Fase 6B). Ate aqui os tres consumidores (tela /diagnostico, painel do SKU
-- e detector do worker) filtravam entity_type='sku': mudanca de preco,
-- titulo ou status de anuncio -- as causas CLASSICAS de virada na venda --
-- NUNCA chegavam ao diagnostico, e describeCandidateCause ja sabia ate
-- descrever order.cancelled/order.returned que nunca chegariam.
--
-- O problema real e o JOIN, e ele vira UMA fonte para os tres consumidores:
--   * entity_type='sku'      -> entity_id e o proprio sku_id (o que ja vinha);
--   * entity_type='listing'  -> entity_id e o item_id do ML; mapeia ao SKU
--     por listings (ml_account_id + item_id -> sku_id). Eventos de Full com
--     inventory_id no entity_id simplesmente nao casam -- sem vinculo, sem
--     correlacao inventada;
--   * entity_type='order'    -> entity_id e o id ML do pedido (orders.id e
--     bigint); mapeia pelos itens CONGELADOS (order_items.sku_id, D-020).
--     Um pedido com dois SKUs candidatos correlaciona com os dois; DISTINCT
--     evita linha dupla quando o mesmo SKU aparece em dois itens.
--
-- VOCABULARIO FECHADO nos ramos de anuncio/pedido, e a exclusao e o ponto:
-- listing.available_quantity.changed e 91% das notificacoes de 24h (1.267,
-- medido 2026-08-30) e e CONSEQUENCIA de venda, nao causa -- inclui-lo
-- inundaria todo diagnostico com ruido vestido de causa. Entra na lista
-- quando alguem provar o contrario, nunca por acidente. No ramo de SKU
-- passam todos (stock.* e baixo-volume e todo significativo -- e e o
-- comportamento que os consumidores ja tinham).
--
-- Guarda do cast: entity_id de pedido fora de ^[0-9]+$ e descartado em vez
-- de derrubar a consulta inteira com erro de cast.
--
-- EXPLAIN (ANALYZE, BUFFERS) 2026-08-30: 34 ms quente, 10.534 buffers,
-- 201 linhas para 50 SKUs candidatos numa janela de 10 dias. Nenhum indice
-- novo. (Primeira execucao fria: 570 ms de leitura de storage.)

create function public.get_sku_correlated_events(
  p_organization_id uuid,
  p_sku_ids uuid[],
  p_from timestamptz,
  p_to timestamptz
)
returns table (sku_id uuid, event_type text, occurred_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  with candidates as (select unnest(p_sku_ids) as sku_id)

  select c.sku_id, e.event_type, e.occurred_at
  from public.domain_events e
  join candidates c on c.sku_id::text = e.entity_id
  where e.organization_id = p_organization_id
    and e.entity_type = 'sku'
    and e.occurred_at >= p_from and e.occurred_at < p_to

  union all

  select l.sku_id, e.event_type, e.occurred_at
  from public.domain_events e
  join public.listings l
    on l.ml_account_id = e.ml_account_id and l.item_id = e.entity_id
  join candidates c on c.sku_id = l.sku_id
  where e.organization_id = p_organization_id
    and e.entity_type = 'listing'
    and e.event_type in (
      'listing.price.changed',
      'listing.title.changed',
      'listing.status.paused',
      'listing.status.reactivated',
      'listing.fulfillment.entered')
    and e.occurred_at >= p_from and e.occurred_at < p_to

  union all

  select distinct oi.sku_id, e.event_type, e.occurred_at
  from public.domain_events e
  join public.order_items oi on e.entity_id ~ '^[0-9]+$' and oi.order_id = e.entity_id::bigint
  join candidates c on c.sku_id = oi.sku_id
  where e.organization_id = p_organization_id
    and e.entity_type = 'order'
    and e.event_type in ('order.cancelled', 'order.returned')
    and e.occurred_at >= p_from and e.occurred_at < p_to

  order by occurred_at
$$;

comment on function public.get_sku_correlated_events(uuid, uuid[], timestamptz, timestamptz) is
  'Eventos correlacionaveis a SKUs candidatos do diagnostico (D-152): eventos do proprio SKU (todos), de ANUNCIO via listings (vocabulario fechado: preco/titulo/status/full -- available_quantity.changed EXCLUIDO de proposito: e consequencia de venda e 91% do ruido) e de PEDIDO via order_items congelados (cancelled/returned). Fonte UNICA dos tres consumidores (/diagnostico, painel do SKU, detector do worker). security invoker: a RLS de domain_events/listings/order_items decide o escopo.';

revoke all on function public.get_sku_correlated_events(uuid, uuid[], timestamptz, timestamptz) from public, anon;
grant execute on function public.get_sku_correlated_events(uuid, uuid[], timestamptz, timestamptz) to authenticated, service_role;
