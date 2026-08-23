-- ============================================================
-- TRANSITO nasce do ciclo do pedido de compra (D-055, docs/ROADMAP.md
-- Fase 4). Fecha o item pendente desde a criação de `purchase_orders`
-- (20260822234353): o ciclo em si nunca tocava o ledger.
--
-- `mark_purchase_order_ordered`/`receive_purchase_order`/
-- `cancel_purchase_order` são `security definer` — a mesma transação que já
-- grava `purchase_order_events` agora também grava `stock_movements`,
-- exatamente o mesmo mecanismo (o dono da função tem privilégio de tabela,
-- os GRANTs para `authenticated`/`anon` continuam bloqueando escrita direta).
--
-- Item sem `sku_id` resolvido não gera movimento — resolve sozinho quando o
-- vínculo nascer, mesmo padrão já usado em `computeSaleDeductions`/
-- `computeNfeApplicationMovements` (nenhum dos dois recalcula o passado).
-- ============================================================

create or replace function public.mark_purchase_order_ordered(p_id uuid, p_expected_at timestamptz default null)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status <> 'APPROVED' then
    raise exception 'pedido % nao esta aprovado (status %)', po.id, po.status;
  end if;

  update public.purchase_orders set
    status = 'ORDERED',
    ordered_at = now(),
    ordered_by = (select auth.uid()),
    expected_at = coalesce(p_expected_at, expected_at)
  where id = p_id
  returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (
    po.organization_id, p_id, 'ORDERED', (select auth.uid()),
    case when p_expected_at is not null then jsonb_build_object('expectedAt', p_expected_at) else '{}'::jsonb end
  );

  -- TRANSITO nasce aqui: compromisso de compra assumido (pedido enviado ao
  -- fornecedor), não confirmação de despacho do fornecedor — a V3 não tem
  -- como observar isso sem integração (D-055).
  insert into public.stock_movements (
    organization_id, sku_id, location_kind, qty_delta, movement_type,
    source_type, source_id, idempotency_key, occurred_at
  )
  select
    po.organization_id, poi.sku_id, 'TRANSITO', poi.quantity_ordered, 'ENTRADA_TRANSITO',
    'PURCHASE_ORDER', po.id::text, 'compra:' || poi.id::text || ':transito', now()
  from public.purchase_order_items poi
  where poi.purchase_order_id = po.id
    and poi.sku_id is not null;

  return result;
end;
$$;

comment on function public.mark_purchase_order_ordered is
  'APPROVED -> ORDERED. Autorização (ADMIN/GESTOR) refeita internamente. Gera ENTRADA_TRANSITO por item com SKU resolvido (D-055).';

create or replace function public.receive_purchase_order(p_id uuid)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status <> 'ORDERED' then
    raise exception 'pedido % nao esta em transito (status %)', po.id, po.status;
  end if;

  update public.purchase_orders
    set status = 'RECEIVED', received_at = now(), received_by = (select auth.uid())
    where id = p_id
    returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id)
  values (po.organization_id, p_id, 'RECEIVED', (select auth.uid()));

  -- Fecha o TRANSITO aberto em mark_purchase_order_ordered. NÃO gera LOCAL —
  -- essa entrada é responsabilidade da NF-e (ENTRADA_NFE), desacoplada de
  -- propósito: receber fisicamente e processar a nota fiscal são atos
  -- distintos, que podem acontecer em momentos diferentes (D-055).
  insert into public.stock_movements (
    organization_id, sku_id, location_kind, qty_delta, movement_type,
    source_type, source_id, idempotency_key, occurred_at
  )
  select
    po.organization_id, poi.sku_id, 'TRANSITO', -poi.quantity_ordered, 'RECEBIMENTO_TRANSITO',
    'PURCHASE_ORDER', po.id::text, 'compra:' || poi.id::text || ':recebimento', now()
  from public.purchase_order_items poi
  where poi.purchase_order_id = po.id
    and poi.sku_id is not null;

  return result;
end;
$$;

comment on function public.receive_purchase_order is
  'ORDERED -> RECEIVED, recebimento total (não parcial nesta etapa). Autorização (ADMIN/GESTOR) refeita internamente. Fecha o TRANSITO com RECEBIMENTO_TRANSITO — não gera LOCAL, isso é NF-e (D-055).';

create or replace function public.cancel_purchase_order(p_id uuid, p_reason text default null)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status in ('RECEIVED', 'CANCELLED') then
    raise exception 'pedido % ja esta em estado terminal (status %)', po.id, po.status;
  end if;

  -- Cancelar um pedido já ORDERED tem TRANSITO aberto por mark_purchase_order_ordered
  -- — fecha com o MESMO tipo do recebimento (RECEBIMENTO_TRANSITO): do ponto
  -- de vista do ledger, "o trânsito encerrou" é o fato relevante, o motivo
  -- (chegou vs. cancelado) já fica no histórico de purchase_order_events
  -- (D-055). DRAFT/APPROVED nunca abriram TRANSITO — nada a reverter.
  if po.status = 'ORDERED' then
    insert into public.stock_movements (
      organization_id, sku_id, location_kind, qty_delta, movement_type,
      source_type, source_id, idempotency_key, occurred_at
    )
    select
      po.organization_id, poi.sku_id, 'TRANSITO', -poi.quantity_ordered, 'RECEBIMENTO_TRANSITO',
      'PURCHASE_ORDER', po.id::text, 'compra:' || poi.id::text || ':transito-cancelado', now()
    from public.purchase_order_items poi
    where poi.purchase_order_id = po.id
      and poi.sku_id is not null;
  end if;

  update public.purchase_orders set
    status = 'CANCELLED',
    cancelled_at = now(),
    cancelled_by = (select auth.uid()),
    cancel_reason = p_reason
  where id = p_id
  returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (
    po.organization_id, p_id, 'CANCELLED', (select auth.uid()),
    case when p_reason is not null then jsonb_build_object('reason', p_reason) else '{}'::jsonb end
  );

  return result;
end;
$$;

comment on function public.cancel_purchase_order is
  'Qualquer estado não-terminal -> CANCELLED. Autorização (ADMIN/GESTOR) refeita internamente. Cancelar um pedido ORDERED fecha o TRANSITO aberto (D-055).';
