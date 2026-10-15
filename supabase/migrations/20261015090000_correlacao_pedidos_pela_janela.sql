-- ============================================================
-- D-463 — get_sku_correlated_events: os eventos de pedido partem da JANELA,
-- não dos itens de todos os pedidos dos candidatos
--
-- O que estava errado: a ramificação de pedidos juntava `domain_events` com
-- `order_items` pelos SKUs candidatos. O banco lia TODOS os itens de pedido
-- dos candidatos -- de sempre, não da janela -- e só depois cruzava com os
-- poucos cancelamentos e devoluções do período. Medido no Dev, como
-- `authenticated` (a mesma medição da D-461): com 100 candidatos e a janela
-- de 5 dias que `/diagnostico` e o detector do worker usam, 146 mil itens
-- lidos para 477 eventos, ~125 mil páginas (~1 GB) por chamada; um SKU só,
-- ~9 mil páginas (5 dias) e ~51 mil (30 dias).
--
-- A correção: primeiro os cancelamentos e devoluções da janela; depois só os
-- itens DESSES pedidos (`order_id = any(lista)`, pelo índice
-- `(order_id, position)`), filtrados pelos candidatos.
--
-- E a conversão deixa de estourar: `entity_id::bigint` só roda quando o texto
-- é um número que cabe em bigint (até 19 dígitos e <= 9223372036854775807),
-- dentro de um CASE, que garante a ordem da avaliação. Antes, um `entity_id`
-- só de dígitos maior que bigint numa janela derrubava a correlação dos três
-- consumidores ("value out of range for type bigint"). Um id assim não casa
-- com nenhum pedido -- não há pedido com esse id.
--
-- O que não muda: o contrato (colunas, vocabulário fechado, janela
-- `[p_from, p_to)`), as ramificações do próprio SKU e dos anúncios, a
-- permissão (invoker, RLS de cada tabela), o `distinct` da ramificação de
-- pedidos. A ordem ganha desempate (`sku_id`, `event_type`) depois do
-- instante, para não depender do plano.
--
-- `language plpgsql` + `force_custom_plan` (D-305).
-- ============================================================

create or replace function public.get_sku_correlated_events(
  p_organization_id uuid,
  p_sku_ids uuid[],
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  sku_id uuid,
  event_type text,
  occurred_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
#variable_conflict use_column
begin
  return query
  with candidates as (select unnest(p_sku_ids) as sku_id),
  eventos_pedido as materialized (
    -- Os cancelamentos e devoluções da janela, com o id do pedido como
    -- número só quando cabe em bigint (o CASE avalia na ordem).
    select e.event_type, e.occurred_at,
      case
        when e.entity_id ~ '^[0-9]{1,19}$'
         and (length(e.entity_id) < 19 or e.entity_id <= '9223372036854775807')
        then e.entity_id::bigint
      end as order_id
    from public.domain_events e
    where e.organization_id = p_organization_id
      and e.entity_type = 'order'
      and e.event_type in ('order.cancelled', 'order.returned')
      and e.occurred_at >= p_from and e.occurred_at < p_to
  ),
  itens as (
    -- Só os itens DESSES pedidos, pelo índice (order_id, position).
    select oi.order_id, oi.sku_id
    from public.order_items oi
    where oi.order_id = any (array(
        select ev.order_id from eventos_pedido ev where ev.order_id is not null
      ))
      and oi.sku_id = any (p_sku_ids)
  ),
  correlacionados as (
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

    select distinct i.sku_id, ev.event_type, ev.occurred_at
    from eventos_pedido ev
    join itens i on i.order_id = ev.order_id
  )
  select r.sku_id, r.event_type, r.occurred_at
  from correlacionados r
  order by r.occurred_at, r.sku_id, r.event_type;
end;
$fn$;

comment on function public.get_sku_correlated_events(uuid, uuid[], timestamptz, timestamptz) is
  'Eventos correlacionaveis a SKUs candidatos do diagnostico (D-152): eventos do proprio SKU (todos), de ANUNCIO via listings (vocabulario fechado: preco/titulo/status/full -- available_quantity.changed EXCLUIDO de proposito: e consequencia de venda e 91% do ruido) e de PEDIDO via order_items congelados (cancelled/returned). Os de pedido partem dos eventos da JANELA e buscam so os itens desses pedidos, com a conversao do id protegida contra estouro (D-463). Fonte UNICA dos tres consumidores (/diagnostico, painel do SKU, detector do worker). security invoker: a RLS de domain_events/listings/order_items decide o escopo.';

revoke all on function public.get_sku_correlated_events(uuid, uuid[], timestamptz, timestamptz) from public, anon;
grant execute on function public.get_sku_correlated_events(uuid, uuid[], timestamptz, timestamptz) to authenticated, service_role;
