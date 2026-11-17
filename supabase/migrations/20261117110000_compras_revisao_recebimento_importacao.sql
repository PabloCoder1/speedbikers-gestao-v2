-- D-722 a D-725: a evolução de compras sem um segundo sistema de compras.
--
-- Tudo aditivo: nenhum estado de `purchase_orders.status` muda, nenhuma coluna
-- some, e os pedidos existentes continuam válidos (as colunas novas nascem
-- nulas, ou com default neutro).
--
-- D-722  Revisão do pedido: a recomendação do sistema e a DECISÃO do comprador
--        por item (manter, reduzir, retirar), com motivo e observação, e o
--        histórico append-only em `purchase_order_review_decisions` — inclusive
--        dos itens RETIRADOS, que deixam de existir no pedido. Criação
--        idempotente por `p_request_id` (o duplo clique não cria dois pedidos).
-- D-723  Fornecedor × SKU (`supplier_skus`): código no fornecedor, custo,
--        moeda, MOQ, múltiplo de embalagem e prazo. Vínculo só explícito —
--        nunca deduzido da marca (D-129).
-- D-724  Recebimento parcial: `quantity_received` por item e
--        `receive_purchase_order_items`, idempotente por pedido de recebimento.
--        O TRANSITO baixa o que chegou; o pedido fica ORDERED até chegar tudo.
--        O saldo LOCAL continua vindo do UpSeller (D-055): o recebimento no
--        sistema não soma estoque local, então não há como entrar duas vezes.
--        `receive_purchase_order` e `cancel_purchase_order` passam a mexer só
--        no que AINDA está em trânsito.
-- D-725  Importação: etapa logística (`logistics_stage`) por cima do status,
--        câmbio do pedido e custos adicionais (`purchase_order_costs`),
--        estimados e realizados em separado. Nada de NCM, imposto, peso ou
--        cubagem inventado: o que não está cadastrado aparece como pendente.

-- ---------------------------------------------------------------------------
-- Colunas novas
-- ---------------------------------------------------------------------------

alter table public.purchase_orders
  add column request_id uuid,
  add column is_import boolean not null default false,
  add column exchange_rate numeric(14, 6) check (exchange_rate is null or exchange_rate > 0),
  add column logistics_stage text check (
    logistics_stage is null or logistics_stage in (
      'COTACAO', 'AGUARDANDO_APROVACAO',
      'EM_PRODUCAO', 'PRONTO_EMBARQUE', 'EMBARCADO', 'EM_TRANSITO', 'DESEMBARACO', 'TRANSPORTE_NACIONAL'
    )
  ),
  add column logistics_stage_at timestamptz,
  add constraint purchase_orders_request_unique unique (organization_id, request_id);

comment on column public.purchase_orders.request_id is
  'Identificador da requisição de criação (D-722), gerado no navegador: repetir a mesma criação devolve o pedido já criado.';
comment on column public.purchase_orders.logistics_stage is
  'Etapa logística por cima do status (D-725). Em DRAFT: COTACAO, AGUARDANDO_APROVACAO. Em ORDERED: EM_PRODUCAO, PRONTO_EMBARQUE, EMBARCADO, EM_TRANSITO, DESEMBARACO, TRANSPORTE_NACIONAL. Zera quando o status muda.';
comment on column public.purchase_orders.exchange_rate is
  'Câmbio do pedido para BRL (D-725), quando a moeda não é BRL. Nulo = câmbio pendente: o custo em reais fica desconhecido, nunca convertido a 1.';

alter table public.purchase_order_items
  add column quantity_received numeric(14, 3) not null default 0,
  add column recommended_quantity numeric(14, 3) check (recommended_quantity is null or recommended_quantity >= 0),
  add column review_recommendation text check (
    review_recommendation is null or review_recommendation in ('MANTER', 'REDUZIR', 'RETIRAR', 'REVISAR')
  ),
  add column review_decision text check (review_decision is null or review_decision in ('MANTER', 'REDUZIR')),
  add column review_reason text check (
    review_reason is null or review_reason in (
      'COMPRA_ESTRATEGICA', 'LANCAMENTO', 'CAMPANHA', 'NEGOCIACAO', 'PEDIDO_ESPECIFICO', 'REPOSICAO_PREVENTIVA', 'OUTRO'
    )
  ),
  add column review_note text check (review_note is null or char_length(btrim(review_note)) between 1 and 500),
  add column supplier_sku_code text check (supplier_sku_code is null or char_length(btrim(supplier_sku_code)) between 1 and 80),
  add constraint purchase_order_items_received_range
    check (quantity_received >= 0 and quantity_received <= quantity_ordered);

comment on column public.purchase_order_items.quantity_received is
  'Quanto deste item já chegou (D-724). O TRANSITO baixa por esta quantidade; o saldo LOCAL continua vindo do UpSeller.';
comment on column public.purchase_order_items.review_recommendation is
  'O que a avaliação de compra recomendou quando o item foi salvo (D-721/D-722). Recomendação, nunca decisão.';
comment on column public.purchase_order_items.review_decision is
  'A decisão do comprador diante da recomendação (D-722): MANTER ou REDUZIR. Retirar tira o item do pedido e fica no histórico de decisões.';

-- Os eventos novos do ciclo.
alter table public.purchase_order_events drop constraint purchase_order_events_event_type_check;
alter table public.purchase_order_events add constraint purchase_order_events_event_type_check
  check (event_type in (
    'CREATED', 'UPDATED', 'APPROVED', 'ORDERED', 'RECEIVED', 'CANCELLED',
    'PARTIALLY_RECEIVED', 'STAGE_CHANGED', 'COSTS_UPDATED'
  ));

-- A etapa logística não sobrevive à troca de status: cada status tem as suas.
create or replace function private.purchase_orders_reset_stage()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and new.logistics_stage is not distinct from old.logistics_stage then
    new.logistics_stage := null;
    new.logistics_stage_at := null;
  end if;

  return new;
end;
$$;

create trigger purchase_orders_reset_stage
  before update on public.purchase_orders
  for each row execute function private.purchase_orders_reset_stage();

-- ---------------------------------------------------------------------------
-- D-722: histórico das decisões de revisão
-- ---------------------------------------------------------------------------

create table public.purchase_order_review_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  sku_id uuid references public.skus(id) on delete set null,
  sku_snapshot text not null check (char_length(btrim(sku_snapshot)) between 1 and 120),
  recommendation text not null check (recommendation in ('MANTER', 'REDUZIR', 'RETIRAR', 'REVISAR')),
  decision text not null check (decision in ('MANTER', 'REDUZIR', 'RETIRAR')),
  quantity_before numeric(14, 3) not null check (quantity_before >= 0),
  quantity_after numeric(14, 3) not null check (quantity_after >= 0),
  recommended_quantity numeric(14, 3) check (recommended_quantity is null or recommended_quantity >= 0),
  reason text check (
    reason is null or reason in (
      'COMPRA_ESTRATEGICA', 'LANCAMENTO', 'CAMPANHA', 'NEGOCIACAO', 'PEDIDO_ESPECIFICO', 'REPOSICAO_PREVENTIVA', 'OUTRO'
    )
  ),
  note text check (note is null or char_length(btrim(note)) between 1 and 500),
  unit_cost numeric(14, 4) check (unit_cost is null or unit_cost >= 0),
  actor_user_id uuid references public.profiles(id) on delete set null,
  decided_at timestamptz not null default now(),
  constraint purchase_order_review_decisions_coherent check (
    (decision = 'RETIRAR' and quantity_after = 0)
    or (decision = 'REDUZIR' and quantity_after < quantity_before)
    or (decision = 'MANTER')
  )
);

comment on table public.purchase_order_review_decisions is
  'Decisões do comprador sobre as recomendações da avaliação de compra (D-722), append-only. Retirar do pedido NÃO exclui o SKU do catálogo, não pausa anúncio e não mexe em estoque.';

create index purchase_order_review_decisions_order_idx
  on public.purchase_order_review_decisions (purchase_order_id, decided_at desc);

alter table public.purchase_order_review_decisions enable row level security;

create policy purchase_order_review_decisions_select_member
  on public.purchase_order_review_decisions for select to authenticated
  using (private.has_org_role(organization_id, array['ADMIN', 'GESTOR']));

revoke all on public.purchase_order_review_decisions from anon, authenticated;
grant select on public.purchase_order_review_decisions to authenticated;
grant select on public.purchase_order_review_decisions to service_role;

create trigger purchase_order_review_decisions_no_update
  before update on public.purchase_order_review_decisions
  for each row execute function private.purchase_order_events_reject_mutation();

create trigger purchase_order_review_decisions_no_delete
  before delete on public.purchase_order_review_decisions
  for each row execute function private.purchase_order_events_reject_mutation();

-- Grava as decisões vindas do formulário (dentro das RPCs de criação e edição).
create or replace function private.record_purchase_order_reviews(
  p_organization_id uuid,
  p_order_id uuid,
  p_review jsonb
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  d jsonb;
  n integer := 0;
  v_sku uuid;
begin
  if p_review is null or jsonb_typeof(p_review) <> 'array' then
    return 0;
  end if;

  for d in select * from jsonb_array_elements(p_review)
  loop
    v_sku := nullif(d->>'skuId', '')::uuid;

    if v_sku is not null
       and (select s.organization_id from public.skus s where s.id = v_sku) is distinct from p_organization_id then
      raise exception 'sku pertence a outra organizacao';
    end if;

    insert into public.purchase_order_review_decisions (
      organization_id, purchase_order_id, sku_id, sku_snapshot, recommendation, decision,
      quantity_before, quantity_after, recommended_quantity, reason, note, unit_cost, actor_user_id
    ) values (
      p_organization_id, p_order_id, v_sku, d->>'skuSnapshot', d->>'recommendation', d->>'decision',
      (d->>'quantityBefore')::numeric, (d->>'quantityAfter')::numeric,
      nullif(d->>'recommendedQuantity', '')::numeric,
      nullif(d->>'reason', ''), nullif(btrim(coalesce(d->>'note', '')), ''),
      nullif(d->>'unitCost', '')::numeric,
      (select auth.uid())
    );

    n := n + 1;
  end loop;

  return n;
end;
$$;

-- Os itens do pedido, a partir do JSON do formulário (as colunas de revisão incluídas).
create or replace function private.insert_purchase_order_items(
  p_organization_id uuid,
  p_order_id uuid,
  p_items jsonb
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  item jsonb;
  pos integer := 0;
begin
  for item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.purchase_order_items (
      organization_id, purchase_order_id, position, sku_id, sku_snapshot, title_snapshot, quantity_ordered, unit_cost,
      recommended_quantity, review_recommendation, review_decision, review_reason, review_note, supplier_sku_code
    ) values (
      p_organization_id,
      p_order_id,
      pos,
      nullif(item->>'skuId', '')::uuid,
      item->>'skuSnapshot',
      item->>'titleSnapshot',
      (item->>'quantityOrdered')::numeric,
      nullif(item->>'unitCost', '')::numeric,
      nullif(item->>'recommendedQuantity', '')::numeric,
      nullif(item->>'reviewRecommendation', ''),
      nullif(item->>'reviewDecision', ''),
      nullif(item->>'reviewReason', ''),
      nullif(btrim(coalesce(item->>'reviewNote', '')), ''),
      nullif(btrim(coalesce(item->>'supplierSkuCode', '')), '')
    );

    pos := pos + 1;
  end loop;

  return pos;
end;
$$;

revoke all on function private.record_purchase_order_reviews(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.insert_purchase_order_items(uuid, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Criação e edição (assinatura nova: parâmetros no FIM, chamadas antigas valem)
-- ---------------------------------------------------------------------------

drop function public.create_purchase_order(uuid, jsonb, uuid, text, text, text, timestamptz);

create function public.create_purchase_order(
  p_organization_id uuid,
  p_items jsonb,
  p_supplier_id uuid default null,
  p_destination_warehouse_name text default null,
  p_currency text default null,
  p_notes text default null,
  p_expected_at timestamptz default null,
  p_request_id uuid default null,
  p_is_import boolean default null,
  p_exchange_rate numeric default null,
  p_review jsonb default null
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.purchase_orders;
  item_count integer;
  review_count integer;
begin
  perform private.check_purchase_order_writer(p_organization_id);

  -- Idempotência (D-722): a mesma requisição devolve o pedido já criado.
  if p_request_id is not null then
    select * into result
    from public.purchase_orders
    where organization_id = p_organization_id and request_id = p_request_id;

    if result.id is not null then
      return result;
    end if;
  end if;

  if p_supplier_id is not null then
    if (select organization_id from public.suppliers where id = p_supplier_id) is distinct from p_organization_id then
      raise exception 'fornecedor pertence a outra organizacao';
    end if;
  end if;

  select count(*) into item_count from jsonb_array_elements(coalesce(p_items, '[]'::jsonb));

  if item_count = 0 then
    raise exception 'pedido de compra precisa de ao menos um item';
  end if;

  insert into public.purchase_orders (
    organization_id, supplier_id, destination_warehouse_name, currency, notes, expected_at, created_by,
    request_id, is_import, exchange_rate
  ) values (
    p_organization_id, p_supplier_id, p_destination_warehouse_name, coalesce(p_currency, 'BRL'), p_notes, p_expected_at,
    (select auth.uid()), p_request_id, coalesce(p_is_import, false), p_exchange_rate
  )
  on conflict (organization_id, request_id) do nothing
  returning * into result;

  -- Corrida entre duas chamadas com a mesma requisição: a segunda devolve a primeira.
  if result.id is null then
    select * into result
    from public.purchase_orders
    where organization_id = p_organization_id and request_id = p_request_id;

    return result;
  end if;

  perform private.insert_purchase_order_items(p_organization_id, result.id, p_items);
  review_count := private.record_purchase_order_reviews(p_organization_id, result.id, p_review);

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (
    p_organization_id, result.id, 'CREATED', (select auth.uid()),
    jsonb_build_object('itemCount', item_count) || case when review_count > 0 then jsonb_build_object('reviewDecisions', review_count) else '{}'::jsonb end
  );

  return result;
end;
$$;

comment on function public.create_purchase_order(uuid, jsonb, uuid, text, text, text, timestamptz, uuid, boolean, numeric, jsonb) is
  'Cria um pedido de compra em rascunho. Autorização (ADMIN/GESTOR) refeita internamente. Idempotente por p_request_id (D-722). Itens aceitam as colunas de revisão; p_review grava as decisões do comprador, inclusive dos itens retirados.';

revoke all on function public.create_purchase_order(uuid, jsonb, uuid, text, text, text, timestamptz, uuid, boolean, numeric, jsonb) from public, anon;
grant execute on function public.create_purchase_order(uuid, jsonb, uuid, text, text, text, timestamptz, uuid, boolean, numeric, jsonb) to authenticated;

drop function public.update_purchase_order_draft(uuid, jsonb, uuid, text, text, text, timestamptz);

create function public.update_purchase_order_draft(
  p_id uuid,
  p_items jsonb,
  p_supplier_id uuid default null,
  p_destination_warehouse_name text default null,
  p_currency text default null,
  p_notes text default null,
  p_expected_at timestamptz default null,
  p_is_import boolean default null,
  p_exchange_rate numeric default null,
  p_review jsonb default null,
  -- Concorrência otimista: o `updated_at` que o formulário leu. Diferente = outra
  -- pessoa salvou no meio, e a edição é recusada em vez de sobrescrever.
  p_expected_updated_at timestamptz default null
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
  item_count integer;
  review_count integer;
begin
  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status <> 'DRAFT' then
    raise exception 'pedido % nao esta em rascunho (status %)', po.id, po.status;
  end if;

  if p_expected_updated_at is not null and po.updated_at is distinct from p_expected_updated_at then
    raise exception 'pedido % foi alterado por outra pessoa', po.id;
  end if;

  if p_supplier_id is not null then
    if (select organization_id from public.suppliers where id = p_supplier_id) is distinct from po.organization_id then
      raise exception 'fornecedor pertence a outra organizacao';
    end if;
  end if;

  select count(*) into item_count from jsonb_array_elements(coalesce(p_items, '[]'::jsonb));

  if item_count = 0 then
    raise exception 'pedido de compra precisa de ao menos um item';
  end if;

  update public.purchase_orders set
    supplier_id = p_supplier_id,
    destination_warehouse_name = p_destination_warehouse_name,
    currency = coalesce(p_currency, 'BRL'),
    notes = p_notes,
    expected_at = p_expected_at,
    is_import = coalesce(p_is_import, is_import),
    exchange_rate = p_exchange_rate
  where id = p_id
  returning * into result;

  delete from public.purchase_order_items where purchase_order_id = p_id;

  perform private.insert_purchase_order_items(po.organization_id, p_id, p_items);
  review_count := private.record_purchase_order_reviews(po.organization_id, p_id, p_review);

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (
    po.organization_id, p_id, 'UPDATED', (select auth.uid()),
    jsonb_build_object('itemCount', item_count) || case when review_count > 0 then jsonb_build_object('reviewDecisions', review_count) else '{}'::jsonb end
  );

  return result;
end;
$$;

comment on function public.update_purchase_order_draft(uuid, jsonb, uuid, text, text, text, timestamptz, boolean, numeric, jsonb, timestamptz) is
  'Substitui os itens e os dados de um rascunho. Autorização (ADMIN/GESTOR) refeita internamente. p_expected_updated_at recusa a edição se outra pessoa salvou no meio (D-722). p_review grava as decisões do comprador.';

revoke all on function public.update_purchase_order_draft(uuid, jsonb, uuid, text, text, text, timestamptz, boolean, numeric, jsonb, timestamptz) from public, anon;
grant execute on function public.update_purchase_order_draft(uuid, jsonb, uuid, text, text, text, timestamptz, boolean, numeric, jsonb, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- D-724: recebimento parcial
-- ---------------------------------------------------------------------------

create or replace function public.receive_purchase_order_items(
  p_id uuid,
  p_items jsonb,
  p_request_id uuid
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
  r jsonb;
  poi public.purchase_order_items;
  v_qty numeric;
  v_received jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_pendente numeric;
begin
  if p_request_id is null then
    raise exception 'recebimento precisa de identificador da requisicao';
  end if;

  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  -- Idempotência: a mesma requisição já registrada não recebe de novo.
  if exists (
    select 1 from public.purchase_order_events e
    where e.purchase_order_id = p_id
      and e.event_type in ('PARTIALLY_RECEIVED', 'RECEIVED')
      and e.metadata->>'requestId' = p_request_id::text
  ) then
    return po;
  end if;

  if po.status <> 'ORDERED' then
    raise exception 'pedido % nao esta em transito (status %)', po.id, po.status;
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_qty := (r->>'quantity')::numeric;

    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    select * into poi
    from public.purchase_order_items i
    where i.id = (r->>'itemId')::uuid and i.purchase_order_id = p_id
    for update;

    if poi.id is null then
      raise exception 'item % nao pertence ao pedido', r->>'itemId';
    end if;

    if poi.quantity_received + v_qty > poi.quantity_ordered then
      raise exception 'recebimento acima do pedido no item % (pedido %, ja recebido %, agora %)',
        poi.sku_snapshot, poi.quantity_ordered, poi.quantity_received, v_qty;
    end if;

    update public.purchase_order_items
      set quantity_received = quantity_received + v_qty
      where id = poi.id;

    if poi.sku_id is not null then
      insert into public.stock_movements (
        organization_id, sku_id, location_kind, qty_delta, movement_type,
        source_type, source_id, idempotency_key, occurred_at
      ) values (
        po.organization_id, poi.sku_id, 'TRANSITO', -v_qty, 'RECEBIMENTO_TRANSITO',
        'PURCHASE_ORDER', po.id::text, 'compra:' || poi.id::text || ':recebimento:' || p_request_id::text, now()
      );
    end if;

    v_received := v_received || jsonb_build_object('itemId', poi.id, 'sku', poi.sku_snapshot, 'quantity', v_qty);
    v_total := v_total + v_qty;
  end loop;

  if v_total = 0 then
    raise exception 'informe ao menos uma quantidade recebida';
  end if;

  select coalesce(sum(i.quantity_ordered - i.quantity_received), 0) into v_pendente
  from public.purchase_order_items i
  where i.purchase_order_id = p_id;

  if v_pendente = 0 then
    update public.purchase_orders
      set status = 'RECEIVED', received_at = now(), received_by = (select auth.uid())
      where id = p_id
      returning * into result;

    insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
    values (po.organization_id, p_id, 'RECEIVED', (select auth.uid()),
            jsonb_build_object('requestId', p_request_id, 'items', v_received, 'partial', false));
  else
    update public.purchase_orders set updated_at = now() where id = p_id returning * into result;

    insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
    values (po.organization_id, p_id, 'PARTIALLY_RECEIVED', (select auth.uid()),
            jsonb_build_object('requestId', p_request_id, 'items', v_received, 'pending', v_pendente));
  end if;

  return result;
end;
$$;

comment on function public.receive_purchase_order_items(uuid, jsonb, uuid) is
  'Recebimento parcial (D-724): [{itemId, quantity}] por requisição idempotente. Baixa o TRANSITO do que chegou; o pedido vira RECEIVED quando nada mais está pendente. O saldo LOCAL continua vindo do UpSeller (D-055).';

revoke all on function public.receive_purchase_order_items(uuid, jsonb, uuid) from public, anon;
grant execute on function public.receive_purchase_order_items(uuid, jsonb, uuid) to authenticated;

-- O recebimento total passa a baixar só o PENDENTE de cada item.
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

  insert into public.stock_movements (
    organization_id, sku_id, location_kind, qty_delta, movement_type,
    source_type, source_id, idempotency_key, occurred_at
  )
  select
    po.organization_id, poi.sku_id, 'TRANSITO', -(poi.quantity_ordered - poi.quantity_received), 'RECEBIMENTO_TRANSITO',
    'PURCHASE_ORDER', po.id::text, 'compra:' || poi.id::text || ':recebimento', now()
  from public.purchase_order_items poi
  where poi.purchase_order_id = po.id
    and poi.sku_id is not null
    and poi.quantity_ordered > poi.quantity_received;

  update public.purchase_order_items
    set quantity_received = quantity_ordered
    where purchase_order_id = p_id;

  update public.purchase_orders
    set status = 'RECEIVED', received_at = now(), received_by = (select auth.uid())
    where id = p_id
    returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id)
  values (po.organization_id, p_id, 'RECEIVED', (select auth.uid()));

  return result;
end;
$$;

comment on function public.receive_purchase_order(uuid) is
  'ORDERED -> RECEIVED: recebe tudo o que ainda está pendente (D-724; antes de D-724, o pedido inteiro). Autorização (ADMIN/GESTOR) refeita internamente. Fecha o TRANSITO com RECEBIMENTO_TRANSITO — não cria LOCAL, que vem do UpSeller (D-055).';

-- Cancelar um pedido em trânsito fecha só o que AINDA estava a caminho.
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

  if po.status = 'ORDERED' then
    insert into public.stock_movements (
      organization_id, sku_id, location_kind, qty_delta, movement_type,
      source_type, source_id, idempotency_key, occurred_at
    )
    select
      po.organization_id, poi.sku_id, 'TRANSITO', -(poi.quantity_ordered - poi.quantity_received), 'RECEBIMENTO_TRANSITO',
      'PURCHASE_ORDER', po.id::text, 'compra:' || poi.id::text || ':transito-cancelado', now()
    from public.purchase_order_items poi
    where poi.purchase_order_id = po.id
      and poi.sku_id is not null
      and poi.quantity_ordered > poi.quantity_received;
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

comment on function public.cancel_purchase_order(uuid, text) is
  'Qualquer estado não-terminal -> CANCELLED. Autorização (ADMIN/GESTOR) refeita internamente. Cancelar um pedido ORDERED fecha só o TRANSITO ainda pendente (D-055, D-724): o que já chegou fica recebido.';

-- ---------------------------------------------------------------------------
-- D-725: etapa logística e custos de importação
-- ---------------------------------------------------------------------------

create or replace function public.set_purchase_order_stage(
  p_id uuid,
  p_stage text,
  p_note text default null
)
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

  if p_stage is not null and not (
    (po.status = 'DRAFT' and p_stage in ('COTACAO', 'AGUARDANDO_APROVACAO'))
    or (po.status = 'ORDERED' and p_stage in (
      'EM_PRODUCAO', 'PRONTO_EMBARQUE', 'EMBARCADO', 'EM_TRANSITO', 'DESEMBARACO', 'TRANSPORTE_NACIONAL'))
  ) then
    raise exception 'etapa % nao vale para pedido com status %', p_stage, po.status;
  end if;

  if po.logistics_stage is not distinct from p_stage then
    return po;
  end if;

  update public.purchase_orders
    set logistics_stage = p_stage, logistics_stage_at = case when p_stage is null then null else now() end
    where id = p_id
    returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (
    po.organization_id, p_id, 'STAGE_CHANGED', (select auth.uid()),
    jsonb_build_object('from', po.logistics_stage, 'to', p_stage)
      || case when nullif(btrim(coalesce(p_note, '')), '') is not null then jsonb_build_object('note', btrim(p_note)) else '{}'::jsonb end
  );

  return result;
end;
$$;

comment on function public.set_purchase_order_stage(uuid, text, text) is
  'Etapa logística do pedido (D-725), validada contra o status: cotação e aguardando aprovação no rascunho; produção, embarque, trânsito, desembaraço e transporte nacional no pedido feito. Nula limpa. Registra STAGE_CHANGED.';

revoke all on function public.set_purchase_order_stage(uuid, text, text) from public, anon;
grant execute on function public.set_purchase_order_stage(uuid, text, text) to authenticated;

create table public.purchase_order_costs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  kind text not null check (kind in (
    'FRETE_INTERNACIONAL', 'SEGURO', 'TRIBUTOS', 'DESPESAS_ADUANEIRAS', 'DESEMBARACO', 'TRANSPORTE_NACIONAL', 'OUTROS'
  )),
  description text check (description is null or char_length(btrim(description)) between 1 and 200),
  amount numeric(14, 2) not null check (amount >= 0),
  currency text not null default 'BRL' check (char_length(currency) = 3),
  exchange_rate numeric(14, 6) check (exchange_rate is null or exchange_rate > 0),
  status text not null default 'ESTIMADO' check (status in ('ESTIMADO', 'REALIZADO')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.purchase_order_costs is
  'Custos adicionais de um pedido (D-725): frete internacional, seguro, tributos, despesas aduaneiras, desembaraço, transporte nacional. ESTIMADO e REALIZADO em separado. Moeda diferente de BRL sem câmbio = valor em reais pendente, nunca convertido a 1.';

create index purchase_order_costs_order_idx on public.purchase_order_costs (purchase_order_id);

create trigger purchase_order_costs_set_updated_at
  before update on public.purchase_order_costs
  for each row execute function private.set_updated_at();

alter table public.purchase_order_costs enable row level security;

create policy purchase_order_costs_select_member
  on public.purchase_order_costs for select to authenticated
  using (private.has_org_role(organization_id, array['ADMIN', 'GESTOR']));

revoke all on public.purchase_order_costs from anon, authenticated;
grant select on public.purchase_order_costs to authenticated;
grant select on public.purchase_order_costs to service_role;

create or replace function public.upsert_purchase_order_cost(
  p_purchase_order_id uuid,
  p_kind text,
  p_amount numeric,
  p_id uuid default null,
  p_description text default null,
  p_currency text default null,
  p_exchange_rate numeric default null,
  p_status text default null
)
returns public.purchase_order_costs
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_order_costs;
begin
  select * into po from public.purchase_orders where id = p_purchase_order_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_purchase_order_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status = 'CANCELLED' then
    raise exception 'pedido % ja esta em estado terminal (status %)', po.id, po.status;
  end if;

  if p_id is null then
    insert into public.purchase_order_costs (
      organization_id, purchase_order_id, kind, description, amount, currency, exchange_rate, status, created_by
    ) values (
      po.organization_id, po.id, p_kind, nullif(btrim(coalesce(p_description, '')), ''), p_amount,
      upper(coalesce(p_currency, 'BRL')), p_exchange_rate, coalesce(p_status, 'ESTIMADO'), (select auth.uid())
    )
    returning * into result;
  else
    update public.purchase_order_costs set
      kind = p_kind,
      description = nullif(btrim(coalesce(p_description, '')), ''),
      amount = p_amount,
      currency = upper(coalesce(p_currency, 'BRL')),
      exchange_rate = p_exchange_rate,
      status = coalesce(p_status, status)
    where id = p_id and purchase_order_id = po.id
    returning * into result;

    if result.id is null then
      raise exception 'custo % nao encontrado', p_id;
    end if;
  end if;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (po.organization_id, po.id, 'COSTS_UPDATED', (select auth.uid()),
          jsonb_build_object('costId', result.id, 'kind', result.kind, 'amount', result.amount,
                             'currency', result.currency, 'status', result.status));

  return result;
end;
$$;

create or replace function public.delete_purchase_order_cost(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.purchase_order_costs;
  po public.purchase_orders;
begin
  select * into c from public.purchase_order_costs where id = p_id;

  if c.id is null then
    raise exception 'custo % nao encontrado', p_id;
  end if;

  select * into po from public.purchase_orders where id = c.purchase_order_id for update;
  perform private.check_purchase_order_writer(po.organization_id);

  delete from public.purchase_order_costs where id = p_id;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (po.organization_id, po.id, 'COSTS_UPDATED', (select auth.uid()),
          jsonb_build_object('costId', c.id, 'kind', c.kind, 'removed', true));
end;
$$;

revoke all on function public.upsert_purchase_order_cost(uuid, text, numeric, uuid, text, text, numeric, text) from public, anon;
grant execute on function public.upsert_purchase_order_cost(uuid, text, numeric, uuid, text, text, numeric, text) to authenticated;
revoke all on function public.delete_purchase_order_cost(uuid) from public, anon;
grant execute on function public.delete_purchase_order_cost(uuid) to authenticated;

-- O custo de chegada (landed cost) do pedido, ESTIMADO e REALIZADO em separado.
create or replace function public.get_purchase_order_landed_cost(p_purchase_order_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with po as (
    select o.* from public.purchase_orders o where o.id = p_purchase_order_id
  ),
  -- Câmbio: BRL vale 1; outra moeda sem câmbio cadastrado fica DESCONHECIDA.
  cambio as (
    select case when po.currency = 'BRL' then 1::numeric else po.exchange_rate end as taxa from po
  ),
  itens as (
    select
      i.id, i.sku_id, i.sku_snapshot, i.quantity_ordered, i.unit_cost,
      i.quantity_ordered * i.unit_cost * (select taxa from cambio) as valor_brl
    from public.purchase_order_items i
    where i.purchase_order_id = p_purchase_order_id
  ),
  custos as (
    select
      c.status,
      sum(c.amount * case when c.currency = 'BRL' then 1 else c.exchange_rate end) as total_brl,
      bool_or(c.currency <> 'BRL' and c.exchange_rate is null) as cambio_pendente
    from public.purchase_order_costs c
    where c.purchase_order_id = p_purchase_order_id
    group by c.status
  ),
  produtos as (
    select
      sum(valor_brl) as total_brl,
      count(*) filter (where unit_cost is null) as itens_sem_custo
    from itens
  )
  select jsonb_build_object(
    'moeda', (select currency from po),
    'cambio', (select taxa from cambio),
    'produtos_brl', round((select total_brl from produtos), 2),
    'itens_sem_custo', (select itens_sem_custo from produtos),
    'adicionais_estimados_brl', round((select total_brl from custos where status = 'ESTIMADO'), 2),
    'adicionais_realizados_brl', round((select total_brl from custos where status = 'REALIZADO'), 2),
    'cambio_pendente', coalesce((select bool_or(cambio_pendente) from custos), false)
                       or ((select currency from po) <> 'BRL' and (select taxa from cambio) is null),
    -- O rateio é pelo VALOR do item (premissa declarada); só existe com o valor
    -- dos produtos inteiro conhecido.
    'itens', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', i.id,
        'sku_id', i.sku_id,
        'sku', i.sku_snapshot,
        'custo_unitario_brl', round(i.unit_cost * (select taxa from cambio), 4),
        'custo_chegada_estimado_brl', case
          when (select itens_sem_custo from produtos) = 0 and (select total_brl from produtos) > 0
          then round(i.unit_cost * (select taxa from cambio)
                     * (1 + coalesce((select total_brl from custos where status = 'ESTIMADO'), 0)
                            / (select total_brl from produtos)), 4) end,
        'custo_chegada_realizado_brl', case
          when (select itens_sem_custo from produtos) = 0 and (select total_brl from produtos) > 0
               and exists (select 1 from custos where status = 'REALIZADO')
          then round(i.unit_cost * (select taxa from cambio)
                     * (1 + (select total_brl from custos where status = 'REALIZADO')
                            / (select total_brl from produtos)), 4) end
      ) order by i.sku_snapshot)
      from itens i), '[]'::jsonb)
  )
  from po;
$$;

comment on function public.get_purchase_order_landed_cost(uuid) is
  'Custo de chegada do pedido (D-725): produtos em BRL pelo câmbio do pedido, custos adicionais estimados e realizados em separado, e o custo unitário de chegada por item rateado pelo valor. Câmbio ausente ou item sem custo = desconhecido, nunca 0.';

revoke all on function public.get_purchase_order_landed_cost(uuid) from public, anon;
grant execute on function public.get_purchase_order_landed_cost(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- D-723: fornecedor × SKU
-- ---------------------------------------------------------------------------

create table public.supplier_skus (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  sku_id uuid not null references public.skus(id) on delete cascade,
  supplier_code text check (supplier_code is null or char_length(btrim(supplier_code)) between 1 and 80),
  description text check (description is null or char_length(btrim(description)) between 1 and 300),
  unit_cost numeric(14, 4) check (unit_cost is null or unit_cost >= 0),
  currency text not null default 'BRL' check (char_length(currency) = 3),
  minimum_order_quantity numeric(14, 3) check (minimum_order_quantity is null or minimum_order_quantity > 0),
  pack_multiple numeric(14, 3) check (pack_multiple is null or pack_multiple > 0),
  lead_time_days integer check (lead_time_days is null or lead_time_days between 0 and 730),
  is_preferred boolean not null default false,
  notes text check (notes is null or char_length(btrim(notes)) between 1 and 500),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_skus_unique unique (supplier_id, sku_id)
);

comment on table public.supplier_skus is
  'Produtos fornecidos (D-723): o vínculo EXPLÍCITO entre fornecedor e SKU, com código no fornecedor, custo, moeda, MOQ, múltiplo de embalagem e prazo. Nunca deduzido da marca (D-129). Campos que a empresa ainda não tem ficam nulos.';

create index supplier_skus_sku_idx on public.supplier_skus (organization_id, sku_id);
create unique index supplier_skus_one_preferred
  on public.supplier_skus (sku_id) where is_preferred;

create trigger supplier_skus_set_updated_at
  before update on public.supplier_skus
  for each row execute function private.set_updated_at();

alter table public.supplier_skus enable row level security;

create policy supplier_skus_select_member
  on public.supplier_skus for select to authenticated
  using (private.has_org_role(organization_id, array['ADMIN', 'GESTOR']));

revoke all on public.supplier_skus from anon, authenticated;
grant select on public.supplier_skus to authenticated;
grant select on public.supplier_skus to service_role;

create or replace function public.upsert_supplier_sku(
  p_supplier_id uuid,
  p_sku_id uuid,
  p_supplier_code text default null,
  p_description text default null,
  p_unit_cost numeric default null,
  p_currency text default null,
  p_minimum_order_quantity numeric default null,
  p_pack_multiple numeric default null,
  p_lead_time_days integer default null,
  p_is_preferred boolean default null,
  p_notes text default null
)
returns public.supplier_skus
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  result public.supplier_skus;
begin
  select organization_id into v_org from public.suppliers where id = p_supplier_id;

  if v_org is null then
    raise exception 'fornecedor % nao encontrado', p_supplier_id;
  end if;

  perform private.check_purchase_order_writer(v_org);

  if (select organization_id from public.skus where id = p_sku_id) is distinct from v_org then
    raise exception 'sku pertence a outra organizacao';
  end if;

  -- Um fornecedor preferido por SKU: marcar este desmarca o anterior.
  if coalesce(p_is_preferred, false) then
    update public.supplier_skus set is_preferred = false
    where sku_id = p_sku_id and is_preferred and supplier_id <> p_supplier_id;
  end if;

  insert into public.supplier_skus (
    organization_id, supplier_id, sku_id, supplier_code, description, unit_cost, currency,
    minimum_order_quantity, pack_multiple, lead_time_days, is_preferred, notes, created_by
  ) values (
    v_org, p_supplier_id, p_sku_id,
    nullif(btrim(coalesce(p_supplier_code, '')), ''), nullif(btrim(coalesce(p_description, '')), ''),
    p_unit_cost, upper(coalesce(p_currency, 'BRL')),
    p_minimum_order_quantity, p_pack_multiple, p_lead_time_days, coalesce(p_is_preferred, false),
    nullif(btrim(coalesce(p_notes, '')), ''), (select auth.uid())
  )
  on conflict (supplier_id, sku_id) do update set
    supplier_code = excluded.supplier_code,
    description = excluded.description,
    unit_cost = excluded.unit_cost,
    currency = excluded.currency,
    minimum_order_quantity = excluded.minimum_order_quantity,
    pack_multiple = excluded.pack_multiple,
    lead_time_days = excluded.lead_time_days,
    is_preferred = excluded.is_preferred,
    notes = excluded.notes
  returning * into result;

  return result;
end;
$$;

create or replace function public.delete_supplier_sku(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.supplier_skus where id = p_id;

  if v_org is null then
    raise exception 'produto do fornecedor % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(v_org);

  delete from public.supplier_skus where id = p_id;
end;
$$;

revoke all on function public.upsert_supplier_sku(uuid, uuid, text, text, numeric, text, numeric, numeric, integer, boolean, text) from public, anon;
grant execute on function public.upsert_supplier_sku(uuid, uuid, text, text, numeric, text, numeric, numeric, integer, boolean, text) to authenticated;
revoke all on function public.delete_supplier_sku(uuid) from public, anon;
grant execute on function public.delete_supplier_sku(uuid) to authenticated;

-- Os produtos de um fornecedor, paginados, com o histórico de compra dele.
create or replace function public.get_supplier_skus(
  p_supplier_id uuid,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select ss.*, s.sku, s.title, s.purchase_cost, s.is_discontinued
    from public.supplier_skus ss
    join public.skus s on s.id = ss.sku_id
    where ss.supplier_id = p_supplier_id
      and (
        nullif(btrim(coalesce(p_search, '')), '') is null
        or s.sku ilike '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        or s.title ilike '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        or ss.supplier_code ilike '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
  ),
  pagina as (
    select b.* from base b
    order by b.is_preferred desc, b.sku
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    offset greatest(coalesce(p_offset, 0), 0)
  ),
  historico as (
    select
      i.sku_id,
      sum(i.quantity_ordered) filter (where o.status <> 'CANCELLED') as unidades_compradas,
      count(distinct o.id) filter (where o.status <> 'CANCELLED') as pedidos,
      max(o.created_at) filter (where o.status <> 'CANCELLED') as ultima_compra
    from public.purchase_order_items i
    join public.purchase_orders o on o.id = i.purchase_order_id
    where o.supplier_id = p_supplier_id
      and i.sku_id in (select p.sku_id from pagina p)
    group by i.sku_id
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'sku_id', p.sku_id, 'sku', p.sku, 'title', p.title,
        'supplier_code', p.supplier_code, 'description', p.description,
        'unit_cost', p.unit_cost, 'currency', p.currency, 'cadastro_cost', p.purchase_cost,
        'minimum_order_quantity', p.minimum_order_quantity, 'pack_multiple', p.pack_multiple,
        'lead_time_days', p.lead_time_days, 'is_preferred', p.is_preferred, 'notes', p.notes,
        'is_discontinued', p.is_discontinued,
        'unidades_compradas', h.unidades_compradas, 'pedidos', coalesce(h.pedidos, 0), 'ultima_compra', h.ultima_compra
      ) order by p.is_preferred desc, p.sku)
      from pagina p left join historico h on h.sku_id = p.sku_id), '[]'::jsonb)
  );
$$;

comment on function public.get_supplier_skus(uuid, text, integer, integer) is
  'Produtos fornecidos por um fornecedor (D-723), paginados (até 200), com busca literal por SKU, título ou código no fornecedor e o histórico de compra com ele (pedidos não cancelados).';

revoke all on function public.get_supplier_skus(uuid, text, integer, integer) from public, anon;
grant execute on function public.get_supplier_skus(uuid, text, integer, integer) to authenticated, service_role;
