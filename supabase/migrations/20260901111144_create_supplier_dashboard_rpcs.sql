-- ============================================================
-- Dashboard individual do Fornecedor (D-174, trilha 5E) — ate o limite do
-- relacionamento REAL, que e menor do que o item sugere.
--
-- O item do ROADMAP pede abas `Visao Geral | Produtos | Pedidos | Custos |
-- Historico` e avisa: "sem fingir relacao fornecedor->SKU inexistente".
-- Medido antes de desenhar: **nao existe** tabela de vinculo fornecedor->SKU
-- (`supplier_product_links` nunca foi criada) e `skus.supplier_brand` e
-- MARCA, nao fornecedor — 19 marcas distintas cobrindo 3.550 SKUs, sem FK
-- nenhuma para `suppliers`.
--
-- O que existe de relacionamento real e o que foi COMPRADO: os itens dos
-- pedidos de compra. Isso nao e ficcao — e observacao. Entao a aba
-- "Produtos" vira "SKUs ja comprados deste fornecedor", derivada dos
-- pedidos, e a tela declara que nao ha catalogo de fornecedor.
--
-- Cancelado sai SEPARADO em vez de sumir: o unico pedido da base hoje esta
-- CANCELLED, e somar tudo num total unico esconderia isso, enquanto excluir
-- em silencio mostraria "1 pedido, R$ 0,00" sem explicar. Mesmo raciocinio
-- de `valor_cancelado` no catalogo de vendas (D-157).
-- ============================================================

create function public.get_supplier_overview(
  p_organization_id uuid,
  p_supplier_id uuid
)
returns table (
  supplier_id uuid,
  name text,
  legal_name text,
  document text,
  contact_name text,
  email text,
  phone text,
  whatsapp text,
  website text,
  notes text,
  is_active boolean,
  orders_total bigint,
  orders_draft bigint,
  orders_approved bigint,
  orders_ordered bigint,
  orders_received bigint,
  orders_cancelled bigint,
  skus_distintos bigint,
  unidades_pedidas numeric,
  valor_pedido numeric,
  unidades_canceladas numeric,
  valor_cancelado numeric,
  primeiro_pedido_em timestamptz,
  ultimo_pedido_em timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with pedidos as (
    select po.id, po.status, po.created_at
    from public.purchase_orders po
    where po.organization_id = p_organization_id
      and po.supplier_id = p_supplier_id
  ),
  itens as (
    select i.sku_id, i.sku_snapshot, i.quantity_ordered, i.unit_cost, p.status
    from public.purchase_order_items i
    join pedidos p on p.id = i.purchase_order_id
  )
  select
    s.id, s.name, s.legal_name, s.document,
    s.contact_name, s.email, s.phone, s.whatsapp, s.website,
    s.notes, s.is_active,
    (select count(*) from pedidos)::bigint,
    (select count(*) from pedidos where status = 'DRAFT')::bigint,
    (select count(*) from pedidos where status = 'APPROVED')::bigint,
    (select count(*) from pedidos where status = 'ORDERED')::bigint,
    (select count(*) from pedidos where status = 'RECEIVED')::bigint,
    (select count(*) from pedidos where status = 'CANCELLED')::bigint,
    -- `sku_snapshot` cobre o item em texto livre, que o formulario aceita de
    -- proposito (vinculo pendente e informacao, nao bloqueio).
    (select count(distinct coalesce(sku_id::text, sku_snapshot)) from itens)::bigint,
    (select coalesce(sum(quantity_ordered), 0) from itens where status <> 'CANCELLED'),
    (select coalesce(round(sum(quantity_ordered * unit_cost), 2), 0) from itens where status <> 'CANCELLED'),
    (select coalesce(sum(quantity_ordered), 0) from itens where status = 'CANCELLED'),
    (select coalesce(round(sum(quantity_ordered * unit_cost), 2), 0) from itens where status = 'CANCELLED'),
    (select min(created_at) from pedidos),
    (select max(created_at) from pedidos)
  from public.suppliers s
  where s.organization_id = p_organization_id and s.id = p_supplier_id
$$;

comment on function public.get_supplier_overview(uuid, uuid) is
  'Resumo de UM fornecedor (D-174): cadastro + agregados dos pedidos de compra, com cancelado SEPARADO (nunca somado ao resto, nunca escondido). Nao existe catalogo fornecedor->SKU no sistema; o unico relacionamento com produto e o que foi comprado. security invoker.';

revoke all on function public.get_supplier_overview(uuid, uuid) from public, anon;
grant execute on function public.get_supplier_overview(uuid, uuid) to authenticated, service_role;

create function public.get_supplier_purchased_skus(
  p_organization_id uuid,
  p_supplier_id uuid,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  pedidos bigint,
  unidades_pedidas numeric,
  unidades_canceladas numeric,
  ultimo_custo numeric,
  ultimo_pedido_numero bigint,
  ultimo_pedido_em timestamptz,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with itens as (
    select
      i.sku_id,
      -- Agrupa por vinculo quando existe e por texto quando nao existe: o
      -- item em texto livre e um SKU legitimo do ponto de vista da compra.
      coalesce(i.sku_id::text, i.sku_snapshot) as chave,
      i.sku_snapshot,
      i.title_snapshot,
      i.quantity_ordered,
      i.unit_cost,
      po.status,
      po.order_number,
      po.created_at
    from public.purchase_order_items i
    join public.purchase_orders po on po.id = i.purchase_order_id
    where po.organization_id = p_organization_id
      and po.supplier_id = p_supplier_id
  ),
  agregado as (
    select
      chave,
      max(sku_id::text)::uuid as sku_id,
      max(sku_snapshot) as sku_snapshot,
      max(title_snapshot) as title_snapshot,
      count(distinct order_number)::bigint as pedidos,
      coalesce(sum(quantity_ordered) filter (where status <> 'CANCELLED'), 0) as unidades_pedidas,
      coalesce(sum(quantity_ordered) filter (where status = 'CANCELLED'), 0) as unidades_canceladas,
      -- Custo do ULTIMO pedido em que o item apareceu — nao a media, que
      -- misturaria negociacoes de epocas diferentes.
      (array_agg(unit_cost order by created_at desc))[1] as ultimo_custo,
      (array_agg(order_number order by created_at desc))[1] as ultimo_pedido_numero,
      max(created_at) as ultimo_pedido_em
    from itens
    group by chave
  )
  select
    a.sku_id,
    coalesce(s.sku, a.sku_snapshot) as sku,
    coalesce(s.title, a.title_snapshot) as title,
    a.pedidos, a.unidades_pedidas, a.unidades_canceladas,
    a.ultimo_custo, a.ultimo_pedido_numero, a.ultimo_pedido_em,
    count(*) over () as total_count
  from agregado a
  left join public.skus s on s.id = a.sku_id
  order by a.ultimo_pedido_em desc, coalesce(s.sku, a.sku_snapshot)
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

comment on function public.get_supplier_purchased_skus(uuid, uuid, integer, integer) is
  'SKUs ja COMPRADOS de um fornecedor (D-174) — derivado dos itens dos pedidos, o unico relacionamento fornecedor->produto que existe de verdade. Agrupa por vinculo quando ha sku_id e por texto quando o item foi digitado livre. Custo e o do ULTIMO pedido, nunca media entre epocas. security invoker.';

revoke all on function public.get_supplier_purchased_skus(uuid, uuid, integer, integer) from public, anon;
grant execute on function public.get_supplier_purchased_skus(uuid, uuid, integer, integer) to authenticated, service_role;
