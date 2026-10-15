-- ============================================================
-- D-461 — get_sku_timeline: os eventos de pedido pelo índice, não pela
-- organização inteira
--
-- O que estava errado: a ramificação de pedidos casava o evento com o item
-- convertendo o texto em número (`oi.order_id = e.entity_id::bigint`). Com a
-- conversão do lado do evento, o índice `domain_events_entity_idx`
-- (organization_id, entity_type, entity_id, occurred_at) só servia até
-- `entity_type`, e o banco lia TODOS os eventos de pedido da organização para
-- depois juntar com os pedidos do SKU. Medido no Dev, como `authenticated`
-- (pedido do A3, telas lentas em produção): ~37 mil páginas (~300 MB) para
-- QUALQUER SKU -- o mais vendido, o mediano e o de cauda --, 4,8 s com o cache
-- frio e 57 ms com ele quente.
--
-- A correção: os pedidos do SKU viram uma lista de textos e o evento é
-- procurado por `entity_id = any(lista)`, que o índice resolve inteiro. Mesmo
-- Dev, mesmos três SKUs: 37,2 mil -> 3,9 mil páginas (o mais vendido), 34,7
-- mil -> 573 (mediano), 34,6 mil -> 36 (cauda); zero diferença no resultado.
--
-- De brinde, a conversão sai: um `entity_id` só de dígitos maior que bigint
-- passava no filtro `~ '^[0-9]+$'` e a conversão derrubava a timeline de
-- todos os SKUs da organização. O texto não estoura.
--
-- E a ordem fica determinística: `m.id` desempata eventos do mesmo instante.
-- Antes, com quatro eventos empatados no corte do 50º (um SKU no Dev), qual
-- deles entrava era arbitrário -- nas duas versões.
--
-- O que não muda: o contrato (colunas, ordem, limite), as ramificações do
-- próprio SKU e dos anúncios (já iam pelo índice), a permissão (invoker, RLS
-- de cada tabela). Um evento de pedido aparece uma vez mesmo com dois itens
-- do SKU no pedido (antes, o `distinct`; agora, a lista). Zero à esquerda no
-- id do pedido deixaria de casar -- o id do pedido do ML não tem, e o Dev tem
-- zero eventos assim.
--
-- `language plpgsql` + `force_custom_plan` (D-305): o plano sai com os
-- valores dos argumentos, e não com o plano genérico do corpo SQL.
-- ============================================================

create or replace function public.get_sku_timeline(
  p_organization_id uuid,
  p_sku_id uuid,
  p_limit integer default 50
)
returns table (
  id uuid,
  occurred_at timestamptz,
  event_type text,
  entity_type text,
  entity_id text,
  severity text,
  before jsonb,
  after jsonb,
  account_label text
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
  with mapped as (
    select e.id, e.occurred_at, e.event_type, e.entity_type, e.entity_id,
           e.severity, e.before, e.after, e.ml_account_id
    from public.domain_events e
    where e.organization_id = p_organization_id
      and e.entity_type = 'sku'
      and e.entity_id = p_sku_id::text

    union all

    select e.id, e.occurred_at, e.event_type, e.entity_type, e.entity_id,
           e.severity, e.before, e.after, e.ml_account_id
    from public.domain_events e
    join public.listings l
      on l.ml_account_id = e.ml_account_id and l.item_id = e.entity_id
    where e.organization_id = p_organization_id
      and e.entity_type = 'listing'
      and l.sku_id = p_sku_id

    union all

    select e.id, e.occurred_at, e.event_type, e.entity_type, e.entity_id,
           e.severity, e.before, e.after, e.ml_account_id
    from public.domain_events e
    where e.organization_id = p_organization_id
      and e.entity_type = 'order'
      -- Os pedidos do SKU como TEXTO, o tipo de `entity_id`: o índice procura
      -- cada um, em vez de ler todos os eventos de pedido da organização.
      and e.entity_id = any (array(
        select distinct oi.order_id::text
        from public.order_items oi
        where oi.sku_id = p_sku_id
      ))
  )
  select m.id, m.occurred_at, m.event_type, m.entity_type, m.entity_id,
         m.severity, m.before, m.after, a.label as account_label
  from mapped m
  left join public.ml_accounts a on a.id = m.ml_account_id
  -- `m.id` desempata eventos do mesmo instante: sem ele, qual deles entra no
  -- corte do limite era arbitrário (medido no Dev: 4 empatados no 50º).
  order by m.occurred_at desc, m.id desc
  limit greatest(p_limit, 0);
end;
$fn$;

comment on function public.get_sku_timeline(uuid, uuid, integer) is
  'Linha do tempo de UM SKU (D-153): todos os eventos mapeaveis a ele -- do proprio SKU, dos seus anuncios (listings por conta+item_id) e dos seus pedidos (order_items congelados, D-020) -- em ordem cronologica decrescente, com before/after para diff documentado e o label da conta. Contrato OPOSTO ao de get_sku_correlated_events no vocabulario, de proposito: correlacao fecha a lista (causa candidata inventada e ruido); timeline e HISTORIA e nao edita o passado. Os eventos de pedido vem pelo indice (entity_id = any(pedidos do SKU como texto), D-461), nunca por conversao do entity_id. security invoker.';

revoke all on function public.get_sku_timeline(uuid, uuid, integer) from public, anon;
grant execute on function public.get_sku_timeline(uuid, uuid, integer) to authenticated, service_role;
