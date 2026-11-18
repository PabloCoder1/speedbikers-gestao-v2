-- D-760 a D-763: "já fiz o pedido" — a compra feita fora do sistema entra pelo
-- MESMO caminho do pedido interno, e a reposição passa a enxergar o que já
-- está encomendado.
--
-- Nada de um segundo controle de trânsito. O pedido externo é um
-- `purchase_orders` comum, criado por `create_purchase_order`, aprovado por
-- `approve_purchase_order` e marcado por `mark_purchase_order_ordered` — a
-- única função que escreve ENTRADA_TRANSITO no ledger (D-055). A sugestão de
-- compra já soma o TRANSITO no aproveitável (`get_purchase_suggestions`), então
-- a quantidade encomendada desconta da necessidade UMA vez, sem subtração
-- nova em lugar nenhum. Planejado (DRAFT/APPROVED) não gera trânsito e por
-- isso não reduz a sugestão: só aparece como indicação.
--
-- D-760  Origem e referência externa do pedido (`origin`,
--        `external_reference`, `supplier_ordered_on`), com unicidade da
--        referência por fornecedor entre os pedidos não cancelados.
-- D-761  `register_placed_purchase_order`: registra o pedido já feito
--        (planejado ou pedido realizado), idempotente pela requisição, e
--        DEVOLVE os candidatos a duplicidade (mesma referência, mesmo SKU já
--        em aberto) em vez de criar um segundo trânsito. Vincular a um pedido
--        existente só grava a referência (`link_purchase_order_external_reference`)
--        e nunca mexe em quantidade. `add_purchase_order_items_placed`
--        acrescenta SKUs a um pedido EXTERNO (o interno se edita pela tela dele).
-- D-762  Previsão de chegada editável no pedido em aberto
--        (`set_purchase_order_expected_at`), com histórico.
-- D-763  A reposição com os pedidos em aberto por SKU: pendente (ORDERED,
--        pedido − recebido), planejado, próxima chegada, atraso; filtro
--        `p_compra` e contagens. Quem não lê pedidos de compra (a RLS de
--        `purchase_orders` é ADMIN/GESTOR) recebe essas colunas NULAS —
--        desconhecido, nunca "sem pedido".

-- ---------------------------------------------------------------------------
-- D-760: origem e referência externa
-- ---------------------------------------------------------------------------

alter table public.purchase_orders
  add column origin text not null default 'INTERNO'
    check (origin in ('INTERNO', 'EXTERNO_MANUAL', 'PLANILHA')),
  add column external_reference text
    check (external_reference is null or char_length(btrim(external_reference)) between 1 and 80),
  add column supplier_ordered_on date,
  -- A chave de comparação: sem espaço e sem caixa. "30632-1", " 30632-1 " e
  -- "30632 -1" são o mesmo pedido; zeros à esquerda e letras ficam como estão.
  add column external_reference_key text
    generated always as (nullif(upper(regexp_replace(coalesce(external_reference, ''), '\s+', '', 'g')), '')) stored;

comment on column public.purchase_orders.origin is
  'De onde o pedido veio (D-760): INTERNO (criado no sistema), EXTERNO_MANUAL ("já fiz o pedido") ou PLANILHA (importação de pedidos anteriores). Não muda a máquina de estados.';
comment on column public.purchase_orders.external_reference is
  'Número ou referência do pedido no fornecedor/importação (D-760), como o usuário informou. Nulo = não informado.';
comment on column public.purchase_orders.supplier_ordered_on is
  'Data em que o pedido foi feito com o fornecedor, quando informada (D-760). Diferente de ordered_at, que é quando o sistema registrou o pedido como feito. Nula = desconhecida, nunca inventada.';

-- A mesma referência do mesmo fornecedor não vira dois pedidos vivos. Sem
-- fornecedor informado, as referências sem fornecedor se comparam entre si.
create unique index purchase_orders_external_reference_unique
  on public.purchase_orders (
    organization_id,
    coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
    external_reference_key
  )
  where external_reference_key is not null and status <> 'CANCELLED';

create index purchase_orders_external_reference_key_idx
  on public.purchase_orders (organization_id, external_reference_key)
  where external_reference_key is not null;

alter table public.purchase_order_events drop constraint purchase_order_events_event_type_check;
alter table public.purchase_order_events add constraint purchase_order_events_event_type_check
  check (event_type in (
    'CREATED', 'UPDATED', 'APPROVED', 'ORDERED', 'RECEIVED', 'CANCELLED',
    'PARTIALLY_RECEIVED', 'STAGE_CHANGED', 'COSTS_UPDATED',
    'EXTERNAL_REGISTERED', 'EXTERNAL_LINKED', 'EXPECTED_CHANGED', 'ITEMS_ADDED'
  ));

-- ---------------------------------------------------------------------------
-- Ajudantes
-- ---------------------------------------------------------------------------

create or replace function private.purchase_reference_key(p_reference text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(upper(regexp_replace(coalesce(p_reference, ''), '\s+', '', 'g')), '');
$$;

revoke all on function private.purchase_reference_key(text) from public, anon, authenticated;

-- Os itens de um pedido já feito, validados: SKU da organização, sem SKU
-- repetido, quantidade positiva. Devolve o JSON no formato de
-- `insert_purchase_order_items` (skuSnapshot/titleSnapshot do cadastro).
create or replace function private.placed_purchase_items(p_organization_id uuid, p_items jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_count integer;
  v_distinct integer;
  v_found integer;
  v_result jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'informe ao menos um SKU com a quantidade encomendada';
  end if;

  if jsonb_array_length(p_items) > 500 then
    raise exception 'no maximo 500 SKUs por pedido';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) e
    where nullif(e->>'skuId', '') is null
       or (e->>'quantity') is null
       or (e->>'quantity') !~ '^[0-9]+(\.[0-9]+)?$'
       or (e->>'quantity')::numeric <= 0
       or (e->>'quantity')::numeric > 100000000
       or ((e->>'unitCost') is not null and ((e->>'unitCost') !~ '^[0-9]+(\.[0-9]+)?$'))
  ) then
    raise exception 'cada item precisa de SKU e quantidade positiva';
  end if;

  select count(*), count(distinct (e->>'skuId')::uuid) into v_count, v_distinct
  from jsonb_array_elements(p_items) e;

  if v_count <> v_distinct then
    raise exception 'o mesmo SKU aparece duas vezes no pedido: some as quantidades numa linha so';
  end if;

  select count(*) into v_found
  from public.skus s
  where s.organization_id = p_organization_id
    and s.id in (select (e->>'skuId')::uuid from jsonb_array_elements(p_items) e);

  if v_found <> v_count then
    raise exception 'SKU nao encontrado nesta organizacao';
  end if;

  select jsonb_agg(jsonb_build_object(
           'skuId', s.id,
           'skuSnapshot', s.sku,
           'titleSnapshot', s.title,
           'quantityOrdered', (e.value->>'quantity')::numeric,
           'unitCost', nullif(e.value->>'unitCost', ''),
           'supplierSkuCode', nullif(btrim(coalesce(e.value->>'supplierSkuCode', '')), '')
         ) order by e.ordinality)
  into v_result
  from jsonb_array_elements(p_items) with ordinality e
  join public.skus s on s.id = (e.value->>'skuId')::uuid and s.organization_id = p_organization_id;

  return v_result;
end;
$$;

revoke all on function private.placed_purchase_items(uuid, jsonb) from public, anon, authenticated;

-- Os candidatos a duplicidade de um pedido já feito: outro pedido vivo com a
-- mesma referência (qualquer fornecedor) e pedidos em aberto com os mesmos
-- SKUs. É o que a tela mostra para o usuário escolher vincular ou registrar.
create or replace function private.placed_purchase_candidates(
  p_organization_id uuid,
  p_reference_key text,
  p_sku_ids uuid[],
  p_exclude_order_id uuid default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(c order by c->>'motivo', (c->>'orderNumber')::bigint), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'motivo', 'MESMA_REFERENCIA',
             'purchaseOrderId', o.id,
             'orderNumber', o.order_number,
             'status', o.status,
             'origin', o.origin,
             'externalReference', o.external_reference,
             'supplierId', o.supplier_id,
             'supplierName', sup.name,
             'skuId', null,
             'sku', null,
             'pendente', null
           ) as c
    from public.purchase_orders o
    left join public.suppliers sup on sup.id = o.supplier_id
    where o.organization_id = p_organization_id
      and p_reference_key is not null
      and o.external_reference_key = p_reference_key
      and o.status <> 'CANCELLED'
      and o.id is distinct from p_exclude_order_id

    union all

    select jsonb_build_object(
             'motivo', 'MESMO_SKU_EM_ABERTO',
             'purchaseOrderId', o.id,
             'orderNumber', o.order_number,
             'status', o.status,
             'origin', o.origin,
             'externalReference', o.external_reference,
             'supplierId', o.supplier_id,
             'supplierName', sup.name,
             'skuId', i.sku_id,
             'sku', i.sku_snapshot,
             'pendente', case when o.status = 'ORDERED' then i.quantity_ordered - i.quantity_received else i.quantity_ordered end
           )
    from public.purchase_order_items i
    join public.purchase_orders o on o.id = i.purchase_order_id
    left join public.suppliers sup on sup.id = o.supplier_id
    where i.organization_id = p_organization_id
      and o.organization_id = p_organization_id
      and i.sku_id = any(p_sku_ids)
      and o.status in ('DRAFT', 'APPROVED', 'ORDERED')
      and (o.status <> 'ORDERED' or i.quantity_ordered > i.quantity_received)
      and o.id is distinct from p_exclude_order_id
      and (p_reference_key is null or o.external_reference_key is distinct from p_reference_key)
  ) q;
$$;

revoke all on function private.placed_purchase_candidates(uuid, text, uuid[], uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- D-761: registrar o pedido já feito
-- ---------------------------------------------------------------------------

create or replace function public.register_placed_purchase_order(
  p_organization_id uuid,
  p_request_id uuid,
  p_items jsonb,
  p_situacao text,
  p_origin text default 'EXTERNO_MANUAL',
  p_supplier_id uuid default null,
  p_external_reference text default null,
  p_supplier_ordered_on date default null,
  p_expected_at timestamptz default null,
  p_stage text default null,
  p_notes text default null,
  p_currency text default null,
  p_is_import boolean default null,
  p_confirm_new boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_key text;
  v_sku_ids uuid[];
  v_candidates jsonb;
  po public.purchase_orders;
begin
  perform private.check_purchase_order_writer(p_organization_id);

  if p_request_id is null then
    raise exception 'registro precisa de identificador da requisicao';
  end if;

  if p_situacao is null or p_situacao not in ('PLANEJADO', 'PEDIDO_REALIZADO') then
    raise exception 'situacao do pedido precisa ser PLANEJADO ou PEDIDO_REALIZADO';
  end if;

  if p_origin is null or p_origin not in ('EXTERNO_MANUAL', 'PLANILHA') then
    raise exception 'origem precisa ser EXTERNO_MANUAL ou PLANILHA';
  end if;

  if p_stage is not null and (
    p_situacao <> 'PEDIDO_REALIZADO'
    or p_stage not in ('EM_PRODUCAO', 'PRONTO_EMBARQUE', 'EMBARCADO', 'EM_TRANSITO', 'DESEMBARACO', 'TRANSPORTE_NACIONAL')
  ) then
    raise exception 'etapa % nao vale para pedido %', p_stage, p_situacao;
  end if;

  if p_supplier_ordered_on is not null and p_supplier_ordered_on > current_date + 1 then
    raise exception 'a data do pedido nao pode estar no futuro';
  end if;

  v_key := private.purchase_reference_key(p_external_reference);

  -- Serializa a mesma requisição e a mesma referência: duas abas, duplo
  -- clique ou a mesma planilha em paralelo nunca criam dois pedidos.
  perform pg_advisory_xact_lock(hashtextextended('po-register:' || p_organization_id::text || ':' || p_request_id::text, 0));
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('po-reference:' || p_organization_id::text || ':' || v_key, 0));
  end if;

  select * into po
  from public.purchase_orders
  where organization_id = p_organization_id and request_id = p_request_id;

  if po.id is not null then
    return jsonb_build_object(
      'resultado', 'JA_REGISTRADO',
      'pedido', jsonb_build_object('id', po.id, 'orderNumber', po.order_number, 'status', po.status),
      'candidatos', '[]'::jsonb
    );
  end if;

  v_items := private.placed_purchase_items(p_organization_id, p_items);
  select array_agg((e->>'skuId')::uuid) into v_sku_ids from jsonb_array_elements(v_items) e;

  -- A mesma referência do mesmo fornecedor (ou ambos sem fornecedor) já
  -- existe: não há "registrar mesmo assim" — é o mesmo pedido.
  if v_key is not null and exists (
    select 1 from public.purchase_orders o
    where o.organization_id = p_organization_id
      and o.external_reference_key = v_key
      and o.status <> 'CANCELLED'
      and o.supplier_id is not distinct from p_supplier_id
  ) then
    return jsonb_build_object(
      'resultado', 'REFERENCIA_EXISTENTE',
      'pedido', null,
      'candidatos', private.placed_purchase_candidates(p_organization_id, v_key, v_sku_ids)
    );
  end if;

  if not coalesce(p_confirm_new, false) then
    v_candidates := private.placed_purchase_candidates(p_organization_id, v_key, v_sku_ids);

    if jsonb_array_length(v_candidates) > 0 then
      return jsonb_build_object('resultado', 'POSSIVEL_DUPLICIDADE', 'pedido', null, 'candidatos', v_candidates);
    end if;
  end if;

  -- O caminho canônico do pedido interno, inteiro: rascunho → aprovado →
  -- feito. O TRANSITO nasce em mark_purchase_order_ordered, e só lá.
  po := public.create_purchase_order(
    p_organization_id => p_organization_id,
    p_items => v_items,
    p_supplier_id => p_supplier_id,
    p_currency => p_currency,
    p_notes => nullif(btrim(coalesce(p_notes, '')), ''),
    p_expected_at => p_expected_at,
    p_request_id => p_request_id,
    p_is_import => p_is_import
  );

  update public.purchase_orders
    set origin = p_origin,
        external_reference = nullif(btrim(coalesce(p_external_reference, '')), ''),
        supplier_ordered_on = p_supplier_ordered_on
    where id = po.id;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (
    p_organization_id, po.id, 'EXTERNAL_REGISTERED', (select auth.uid()),
    jsonb_strip_nulls(jsonb_build_object(
      'origin', p_origin,
      'situacao', p_situacao,
      'externalReference', nullif(btrim(coalesce(p_external_reference, '')), ''),
      'supplierOrderedOn', p_supplier_ordered_on,
      'confirmedDespiteCandidates', case when coalesce(p_confirm_new, false) then true end
    ))
  );

  if p_situacao = 'PEDIDO_REALIZADO' then
    perform public.approve_purchase_order(po.id);
    perform public.mark_purchase_order_ordered(po.id, p_expected_at);

    if p_stage is not null then
      perform public.set_purchase_order_stage(po.id, p_stage, null);
    end if;
  end if;

  select * into po from public.purchase_orders where id = po.id;

  return jsonb_build_object(
    'resultado', 'CRIADO',
    'pedido', jsonb_build_object('id', po.id, 'orderNumber', po.order_number, 'status', po.status),
    'candidatos', '[]'::jsonb
  );
end;
$$;

comment on function public.register_placed_purchase_order(uuid, uuid, jsonb, text, text, uuid, text, date, timestamptz, text, text, text, boolean, boolean) is
  'Pedido já feito (D-761): PLANEJADO cria rascunho (não reduz a sugestão); PEDIDO_REALIZADO passa por create → approve → mark_purchase_order_ordered, e o TRANSITO nasce só lá. Idempotente por p_request_id. Sem p_confirm_new, devolve POSSIVEL_DUPLICIDADE com os candidatos (mesma referência, mesmo SKU em aberto) em vez de criar; a mesma referência do mesmo fornecedor devolve REFERENCIA_EXISTENTE sempre. Autorização ADMIN/GESTOR.';

revoke all on function public.register_placed_purchase_order(uuid, uuid, jsonb, text, text, uuid, text, date, timestamptz, text, text, text, boolean, boolean) from public, anon;
grant execute on function public.register_placed_purchase_order(uuid, uuid, jsonb, text, text, uuid, text, date, timestamptz, text, text, text, boolean, boolean) to authenticated;

-- Vincular uma referência externa a um pedido que já existe (o interno que
-- também aparece no controle de chegada). Só a referência: quantidade, status
-- e trânsito ficam como estão.
create or replace function public.link_purchase_order_external_reference(
  p_id uuid,
  p_external_reference text,
  p_supplier_ordered_on date default null
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
  v_key text := private.purchase_reference_key(p_external_reference);
begin
  if v_key is null then
    raise exception 'informe a referencia do pedido';
  end if;

  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status = 'CANCELLED' then
    raise exception 'pedido % esta cancelado', po.order_number;
  end if;

  if po.external_reference_key is not null then
    if po.external_reference_key = v_key then
      return po;
    end if;

    raise exception 'o pedido % ja tem a referencia %: corrija pela tela do pedido', po.order_number, po.external_reference;
  end if;

  if p_supplier_ordered_on is not null and p_supplier_ordered_on > current_date + 1 then
    raise exception 'a data do pedido nao pode estar no futuro';
  end if;

  update public.purchase_orders
    set external_reference = btrim(p_external_reference),
        supplier_ordered_on = coalesce(p_supplier_ordered_on, supplier_ordered_on)
    where id = p_id
    returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (
    po.organization_id, p_id, 'EXTERNAL_LINKED', (select auth.uid()),
    jsonb_strip_nulls(jsonb_build_object('externalReference', btrim(p_external_reference), 'supplierOrderedOn', p_supplier_ordered_on))
  );

  return result;
exception
  when unique_violation then
    raise exception 'a referencia % ja esta em outro pedido deste fornecedor', btrim(p_external_reference);
end;
$$;

comment on function public.link_purchase_order_external_reference(uuid, text, date) is
  'Vincula a referência externa a um pedido existente (D-761) — o pedido interno que também está no controle de chegada. Não mexe em quantidade, status nem trânsito; referência diferente já gravada é recusada (corrige-se pela tela do pedido). Registra EXTERNAL_LINKED.';

revoke all on function public.link_purchase_order_external_reference(uuid, text, date) from public, anon;
grant execute on function public.link_purchase_order_external_reference(uuid, text, date) to authenticated;

-- Acrescentar SKUs a um pedido EXTERNO já registrado: vários SKUs no mesmo
-- pedido de importação, registrados em momentos diferentes.
create or replace function public.add_purchase_order_items_placed(
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
  v_items jsonb;
  v_pos integer;
  item jsonb;
  v_item_id uuid;
  v_added jsonb := '[]'::jsonb;
begin
  if p_request_id is null then
    raise exception 'acrescimo precisa de identificador da requisicao';
  end if;

  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if exists (
    select 1 from public.purchase_order_events e
    where e.purchase_order_id = p_id and e.event_type = 'ITEMS_ADDED'
      and e.metadata->>'requestId' = p_request_id::text
  ) then
    return po;
  end if;

  if po.origin = 'INTERNO' then
    raise exception 'pedido interno se edita pela tela do pedido, nao por aqui';
  end if;

  if po.status not in ('DRAFT', 'APPROVED', 'ORDERED') then
    raise exception 'pedido % nao aceita itens (status %)', po.order_number, po.status;
  end if;

  v_items := private.placed_purchase_items(po.organization_id, p_items);

  if exists (
    select 1 from public.purchase_order_items i
    where i.purchase_order_id = p_id
      and i.sku_id in (select (e->>'skuId')::uuid from jsonb_array_elements(v_items) e)
  ) then
    raise exception 'o SKU ja esta neste pedido: ajuste a quantidade pela tela do pedido';
  end if;

  select coalesce(max(position), -1) + 1 into v_pos from public.purchase_order_items where purchase_order_id = p_id;

  for item in select * from jsonb_array_elements(v_items)
  loop
    insert into public.purchase_order_items (
      organization_id, purchase_order_id, position, sku_id, sku_snapshot, title_snapshot,
      quantity_ordered, unit_cost, supplier_sku_code
    ) values (
      po.organization_id, p_id, v_pos, (item->>'skuId')::uuid, item->>'skuSnapshot', item->>'titleSnapshot',
      (item->>'quantityOrdered')::numeric, nullif(item->>'unitCost', '')::numeric, item->>'supplierSkuCode'
    )
    returning id into v_item_id;

    -- Pedido já feito: o item novo entra em trânsito com a MESMA chave de
    -- mark_purchase_order_ordered — a mesma unidade nunca entra duas vezes.
    if po.status = 'ORDERED' then
      insert into public.stock_movements (
        organization_id, sku_id, location_kind, qty_delta, movement_type,
        source_type, source_id, idempotency_key, occurred_at
      ) values (
        po.organization_id, (item->>'skuId')::uuid, 'TRANSITO', (item->>'quantityOrdered')::numeric, 'ENTRADA_TRANSITO',
        'PURCHASE_ORDER', p_id::text, 'compra:' || v_item_id::text || ':transito', now()
      );
    end if;

    v_added := v_added || jsonb_build_object('itemId', v_item_id, 'sku', item->>'skuSnapshot', 'quantity', (item->>'quantityOrdered')::numeric);
    v_pos := v_pos + 1;
  end loop;

  update public.purchase_orders set updated_at = now() where id = p_id returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (po.organization_id, p_id, 'ITEMS_ADDED', (select auth.uid()),
          jsonb_build_object('requestId', p_request_id, 'items', v_added));

  return result;
end;
$$;

comment on function public.add_purchase_order_items_placed(uuid, jsonb, uuid) is
  'Acrescenta SKUs a um pedido EXTERNO (origem EXTERNO_MANUAL ou PLANILHA) em rascunho, aprovado ou feito (D-761). Idempotente por p_request_id; SKU já no pedido é recusado. No pedido feito, o item novo entra em TRANSITO com a mesma chave de mark_purchase_order_ordered. Registra ITEMS_ADDED.';

revoke all on function public.add_purchase_order_items_placed(uuid, jsonb, uuid) from public, anon;
grant execute on function public.add_purchase_order_items_placed(uuid, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- D-762: previsão de chegada editável
-- ---------------------------------------------------------------------------

create or replace function public.set_purchase_order_expected_at(
  p_id uuid,
  p_expected_at timestamptz,
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

  if po.status in ('RECEIVED', 'CANCELLED') then
    raise exception 'pedido % ja esta em estado terminal (status %)', po.order_number, po.status;
  end if;

  if po.expected_at is not distinct from p_expected_at then
    return po;
  end if;

  update public.purchase_orders set expected_at = p_expected_at where id = p_id returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (
    po.organization_id, p_id, 'EXPECTED_CHANGED', (select auth.uid()),
    jsonb_build_object('from', po.expected_at, 'to', p_expected_at)
      || case when nullif(btrim(coalesce(p_note, '')), '') is not null then jsonb_build_object('note', btrim(p_note)) else '{}'::jsonb end
  );

  return result;
end;
$$;

comment on function public.set_purchase_order_expected_at(uuid, timestamptz, text) is
  'Previsão de chegada do pedido em aberto (D-762); nula limpa (desconhecida). Registra EXPECTED_CHANGED com o valor anterior. Autorização ADMIN/GESTOR.';

revoke all on function public.set_purchase_order_expected_at(uuid, timestamptz, text) from public, anon;
grant execute on function public.set_purchase_order_expected_at(uuid, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- D-763: os pedidos em aberto de uma página de SKUs
-- ---------------------------------------------------------------------------

create or replace function public.get_open_purchases_for_skus(
  p_organization_id uuid,
  p_sku_ids uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    -- O mesmo teste de private.has_org_role, que esta função (invoker) não alcança.
    when not exists (select 1 from public.organization_members m where m.user_id = (select auth.uid()) and m.organization_id = p_organization_id and m.role in ('ADMIN', 'GESTOR')) then null
    else coalesce((
      select jsonb_agg(jsonb_build_object(
               'skuId', i.sku_id,
               'itemId', i.id,
               'purchaseOrderId', o.id,
               'orderNumber', o.order_number,
               'status', o.status,
               'logisticsStage', o.logistics_stage,
               'origin', o.origin,
               'externalReference', o.external_reference,
               'supplierName', sup.name,
               'quantityOrdered', i.quantity_ordered,
               'quantityReceived', i.quantity_received,
               'pendente', case when o.status = 'ORDERED' then i.quantity_ordered - i.quantity_received end,
               'expectedAt', o.expected_at,
               'supplierOrderedOn', o.supplier_ordered_on,
               'orderedAt', o.ordered_at
             ) order by i.sku_id, o.expected_at nulls last, o.order_number)
      from public.purchase_order_items i
      join public.purchase_orders o on o.id = i.purchase_order_id
      left join public.suppliers sup on sup.id = o.supplier_id
      where i.organization_id = p_organization_id
        and o.organization_id = p_organization_id
        and i.sku_id = any(p_sku_ids[1:500])
        and o.status in ('DRAFT', 'APPROVED', 'ORDERED')
        and (o.status <> 'ORDERED' or i.quantity_ordered > i.quantity_received)
    ), '[]'::jsonb)
  end;
$$;

comment on function public.get_open_purchases_for_skus(uuid, uuid[]) is
  'Os pedidos em aberto (rascunho, aprovado, e feito com saldo a chegar) de até 500 SKUs (D-763), um item por linha, para o painel "pedido já feito" da reposição. Nulo para quem não lê pedidos de compra (ADMIN/GESTOR): desconhecido, nunca lista vazia. security invoker.';

revoke all on function public.get_open_purchases_for_skus(uuid, uuid[]) from public, anon;
grant execute on function public.get_open_purchases_for_skus(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- D-763: a visão da reposição com os pedidos em aberto e o filtro de compra
-- ---------------------------------------------------------------------------
--
-- A mesma leitura de D-358 (uma classificação do catálogo), com uma junção ao
-- agregado dos pedidos em aberto POR SKU. O cálculo da sugestão não muda: o
-- pendente do pedido feito já está no TRANSITO do ledger, e somá-lo de novo
-- seria a dupla contagem. As colunas novas são só leitura para a tela.

drop function public.get_replenishment_overview(uuid, date, text, text, text, integer, integer);

create function public.get_replenishment_overview(
  p_organization_id uuid,
  p_date_to date,
  p_supplier_brand text default null,
  p_search text default null,
  p_state text default null,
  p_limit integer default 100,
  p_offset integer default 0,
  p_compra text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $function$
declare
  resultado jsonb;
  -- O mesmo teste de private.has_org_role (D-763), que uma função invoker não alcança.
  v_compras_visiveis boolean := exists (select 1 from public.organization_members m where m.user_id = (select auth.uid()) and m.organization_id = p_organization_id and m.role in ('ADMIN', 'GESTOR'));
  v_hoje date := coalesce(p_date_to, (now() at time zone 'America/Sao_Paulo')::date);
begin
  if p_compra is not null then
    if p_compra not in ('SEM_PEDIDO', 'ENCOMENDADO', 'COMPLEMENTAR', 'ATRASADO', 'CHEGADA_PREVISTA', 'PLANEJADO') then
      raise exception 'filtro de compra desconhecido: %', p_compra;
    end if;

    if not v_compras_visiveis then
      raise exception 'sem permissao para filtrar por pedidos de compra';
    end if;
  end if;

  with base as (
    -- UMA classificacao do catalogo, sem filtro de estado: os cartoes precisam
    -- dos outros estados quando um deles esta ativo (D-250).
    select o.*
    from public.get_purchase_suggestions(
           p_organization_id, p_date_to, p_supplier_brand, p_search, 1000000, 0, null
         ) with ordinality as o(
           sku_id, sku, title, supplier_brand, purchase_cost, stock_is_virtual,
           local_quantity, reservado, transito, full_quantity,
           units_15d, units_30d, units_60d, units_90d, history_days_90,
           abc_class, coverage_days, state, suggested_quantity, total_count,
           units_30d_shopee, units_90d_shopee, ordem
         )
  ),
  compras as (
    -- D-763: os pedidos em aberto por SKU. Pendente = pedido feito ainda a
    -- chegar (pedido - recebido); planejado = rascunho e aprovado.
    select
      i.sku_id,
      sum(i.quantity_ordered - i.quantity_received) filter (where o.status = 'ORDERED') as pendente,
      sum(i.quantity_ordered) filter (where o.status in ('DRAFT', 'APPROVED')) as planejado,
      min(o.expected_at) filter (where o.status = 'ORDERED' and i.quantity_ordered > i.quantity_received) as proxima_chegada,
      coalesce(bool_or(
        o.status = 'ORDERED' and i.quantity_ordered > i.quantity_received
        and o.expected_at is not null
        -- A previsão é a data de negócio gravada como meia-noite UTC (D-365).
        and (o.expected_at at time zone 'UTC')::date < v_hoje
      ), false) as atrasado,
      count(distinct o.id) filter (where o.status = 'ORDERED' and i.quantity_ordered > i.quantity_received) as pedidos
    from public.purchase_order_items i
    join public.purchase_orders o on o.id = i.purchase_order_id
    where v_compras_visiveis
      and i.organization_id = p_organization_id
      and o.organization_id = p_organization_id
      and i.sku_id is not null
      and o.status in ('DRAFT', 'APPROVED', 'ORDERED')
      and (o.status <> 'ORDERED' or i.quantity_ordered > i.quantity_received)
    group by i.sku_id
  ),
  todas as (
    select
      b.*,
      -- Quem não lê pedidos de compra recebe NULO: desconhecido, nunca zero.
      case when v_compras_visiveis then coalesce(c.pendente, 0) end as compra_pendente,
      case when v_compras_visiveis then coalesce(c.planejado, 0) end as compra_planejada,
      case when v_compras_visiveis then c.proxima_chegada end as compra_proxima_chegada,
      case when v_compras_visiveis then coalesce(c.atrasado, false) end as compra_atrasada,
      case when v_compras_visiveis then coalesce(c.pedidos, 0) end as compra_pedidos
    from base b
    left join compras c on c.sku_id = b.sku_id
  ),
  marcada as (
    select
      t.*,
      (p_state is null
        or (p_state = 'SEM_ESTADO' and t.state is null)
        or t.state = p_state) as passa_estado,
      (p_compra is null
        or (p_compra = 'SEM_PEDIDO' and t.compra_pendente = 0 and t.compra_planejada = 0)
        or (p_compra = 'ENCOMENDADO' and t.compra_pendente > 0)
        or (p_compra = 'COMPLEMENTAR' and t.compra_pendente > 0 and t.suggested_quantity > 0)
        or (p_compra = 'ATRASADO' and t.compra_atrasada)
        or (p_compra = 'CHEGADA_PREVISTA' and t.compra_pendente > 0 and t.compra_proxima_chegada is not null and not t.compra_atrasada)
        or (p_compra = 'PLANEJADO' and t.compra_planejada > 0)) as passa_compra
    from todas t
  ),
  filtrada as (
    select m.* from marcada m where m.passa_estado and m.passa_compra
  ),
  contagens as (
    -- Os cartões de estado respeitam o filtro de compra (e não o de estado).
    select
      coalesce(t.state, 'SEM_ESTADO') as state,
      count(*)::bigint as skus,
      coalesce(sum(t.suggested_quantity) filter (where t.suggested_quantity > 0), 0)::bigint as unidades,
      round(coalesce(sum(t.suggested_quantity * t.purchase_cost)
        filter (where t.suggested_quantity > 0 and t.purchase_cost > 0), 0), 2) as investimento,
      count(*) filter (where t.suggested_quantity > 0
                         and (t.purchase_cost is null or t.purchase_cost <= 0))::bigint as sem_custo
    from marcada t
    where t.passa_compra
    group by 1
  ),
  pagina as (
    select f.*
    from filtrada f
    order by f.ordem
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrada),
    'contagens', coalesce((
      select jsonb_agg(jsonb_build_object(
               'state', c.state, 'skus', c.skus, 'unidades', c.unidades,
               'investimento', c.investimento, 'sem_custo', c.sem_custo))
      from contagens c), '[]'::jsonb),
    -- D-763: as contagens do filtro de compra, no conjunto do filtro de
    -- estado. Nulas para quem não lê pedidos de compra.
    'contagens_compra', case when v_compras_visiveis then (
      select jsonb_build_object(
        'sem_pedido', count(*) filter (where m.compra_pendente = 0 and m.compra_planejada = 0),
        'encomendado', count(*) filter (where m.compra_pendente > 0),
        'complementar', count(*) filter (where m.compra_pendente > 0 and m.suggested_quantity > 0),
        'atrasado', count(*) filter (where m.compra_atrasada),
        'chegada_prevista', count(*) filter (where m.compra_pendente > 0 and m.compra_proxima_chegada is not null and not m.compra_atrasada),
        'planejado', count(*) filter (where m.compra_planejada > 0),
        'unidades_encomendadas', coalesce(sum(m.compra_pendente), 0))
      from marcada m
      where m.passa_estado) end,
    -- Os agregados que a tela mostra sem somar nada: o total de todos os
    -- estados e o "comprar agora" (ruptura + compra urgente), no MESMO
    -- conjunto dos cartoes.
    'totais', (
      select jsonb_build_object(
        'skus', count(*),
        'unidades', coalesce(sum(t.suggested_quantity) filter (where t.suggested_quantity > 0), 0),
        'investimento', round(coalesce(sum(t.suggested_quantity * t.purchase_cost)
          filter (where t.suggested_quantity > 0 and t.purchase_cost > 0), 0), 2),
        'sem_custo', count(*) filter (where t.suggested_quantity > 0
                                       and (t.purchase_cost is null or t.purchase_cost <= 0)))
      from todas t),
    'comprar_agora', (
      select jsonb_build_object(
        'skus', count(*),
        'unidades', coalesce(sum(t.suggested_quantity) filter (where t.suggested_quantity > 0), 0),
        'investimento', round(coalesce(sum(t.suggested_quantity * t.purchase_cost)
          filter (where t.suggested_quantity > 0 and t.purchase_cost > 0), 0), 2),
        'sem_custo', count(*) filter (where t.suggested_quantity > 0
                                       and (t.purchase_cost is null or t.purchase_cost <= 0)))
      from todas t
      where t.state in ('RUPTURA', 'COMPRA_URGENTE')),
    'linhas', coalesce((
      select jsonb_agg((to_jsonb(p) - 'ordem' - 'total_count' - 'passa_estado' - 'passa_compra') order by p.ordem)
      from pagina p), '[]'::jsonb),
    -- O frescor das duas entradas que envelhecem sozinhas. NULL = nunca houve.
    'vendas_calculadas_em', (
      select max(m.computed_at) from public.daily_sku_metrics m
      where m.organization_id = p_organization_id
        and m.metric_date > coalesce(p_date_to, current_date) - 90),
    -- O frescor do Full sai da MESMA leitura canonica que o Full conta (D-173,
    -- D-204): a captura mais recente de cada (conta, inventory_id) na janela
    -- de 3 dias.
    'full_capturado_em', (
      select max(q.captured_at)
      from (
        select distinct on (f.ml_account_id, f.inventory_id) f.captured_at
        from public.fulfillment_stock_snapshots f
        where f.organization_id = p_organization_id
          and f.captured_at >= now() - interval '3 days'
        order by f.ml_account_id, f.inventory_id, f.captured_at desc
      ) q)
  )
  into resultado;

  return resultado;
end
$function$;

comment on function public.get_replenishment_overview(uuid, date, text, text, text, integer, integer, text) is
  'A leitura de /reposicao (D-358, D-763): UMA chamada a get_purchase_suggestions sem filtro de estado, com os pedidos em aberto por SKU (compra_pendente = pedido feito a chegar, compra_planejada = rascunho/aprovado, próxima chegada, atraso — nulos para quem não lê pedidos de compra). Filtros p_state e p_compra; os cartões de estado respeitam o de compra e contagens_compra respeita o de estado. A sugestão não muda: o pendente já está no TRANSITO. security invoker.';

revoke all on function public.get_replenishment_overview(uuid, date, text, text, text, integer, integer, text) from public, anon;
grant execute on function public.get_replenishment_overview(uuid, date, text, text, text, integer, integer, text) to authenticated, service_role;
