-- D-792: o recebimento do pedido de compra dá entrada no estoque da loja, e a
-- conferência da importação cria o SKU que ainda não existe no catálogo.
--
-- 1. `stock_movements.movement_type` ganha ENTRADA_COMPRA: o par LOCAL do
--    RECEBIMENTO_TRANSITO. Receber (parcial ou total) fecha o trânsito do que
--    chegou E soma a mesma quantidade no LOCAL, na mesma transação. Muda D-055
--    por decisão do dono (19/11): a mercadoria recebida aparece no estoque na
--    hora. A conciliação com o UpSeller continua corrigindo o LOCAL para o
--    saldo do ERP (D-029); a nota de entrada do mesmo pedido não deve ser
--    lançada de novo.
-- 2. `create_skus_from_import_rows`: cria o SKU com o código, a descrição e o
--    NCM que a própria linha da invoice trouxe e vincula a linha. Código que
--    já existe só vincula; o mesmo código em várias linhas cria um SKU só;
--    código parecido com um do catálogo (KC30 × KC0030) não é criado — o
--    usuário vincula pela busca, para não nascer produto duplicado.
-- 3. `get_purchase_orders_overview`: a linha traz a moeda do pedido, e os
--    cartões somam em reais pelo câmbio do pedido (pedido em dólar aparecia
--    como R$).

-- ---------------------------------------------------------------------------
-- 1. ENTRADA_COMPRA
-- ---------------------------------------------------------------------------

alter table public.stock_movements drop constraint stock_movements_movement_type_check;

alter table public.stock_movements add constraint stock_movements_movement_type_check check (movement_type in (
  'ENTRADA_NFE', 'SAIDA_NFE', 'VENDA_ML', 'CANCELAMENTO_ML',
  'DEVOLUCAO_ML', 'AJUSTE_MANUAL', 'AJUSTE_RECONCILIACAO', 'TRANSFERENCIA',
  'RESERVA', 'LIBERACAO_RESERVA', 'ENTRADA_TRANSITO', 'RECEBIMENTO_TRANSITO',
  'ESTORNO_PRE_CAPTURA', 'ESTORNO_REVERSAO_EXCEDENTE', 'SAIDA_DOCUMENTO', 'ESTORNO_FULL',
  'VENDA_SHOPEE', 'CANCELAMENTO_SHOPEE', 'ESTORNO_ARMAZEM_SHOPEE',
  -- D-792: o recebimento do pedido de compra no estoque da loja.
  'ENTRADA_COMPRA'
));

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
      -- Sai do trânsito e entra na loja: o par na mesma transação (D-792).
      insert into public.stock_movements (
        organization_id, sku_id, location_kind, qty_delta, movement_type,
        source_type, source_id, idempotency_key, occurred_at
      ) values
        (po.organization_id, poi.sku_id, 'TRANSITO', -v_qty, 'RECEBIMENTO_TRANSITO',
         'PURCHASE_ORDER', po.id::text, 'compra:' || poi.id::text || ':recebimento:' || p_request_id::text, now()),
        (po.organization_id, poi.sku_id, 'LOCAL', v_qty, 'ENTRADA_COMPRA',
         'PURCHASE_ORDER', po.id::text, 'compra:' || poi.id::text || ':entrada:' || p_request_id::text, now());
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
  'Recebimento parcial (D-724, D-792): [{itemId, quantity}] por requisição idempotente. Baixa o TRANSITO do que chegou e soma o mesmo no LOCAL (ENTRADA_COMPRA); o pedido vira RECEIVED quando nada mais está pendente. A conciliação com o UpSeller continua acertando o LOCAL.';

revoke all on function public.receive_purchase_order_items(uuid, jsonb, uuid) from public, anon;
grant execute on function public.receive_purchase_order_items(uuid, jsonb, uuid) to authenticated;

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
  select po.organization_id, poi.sku_id, m.location_kind, m.sinal * (poi.quantity_ordered - poi.quantity_received), m.movement_type,
         'PURCHASE_ORDER', po.id::text, 'compra:' || poi.id::text || m.sufixo, now()
  from public.purchase_order_items poi
  cross join (values ('TRANSITO', -1, 'RECEBIMENTO_TRANSITO', ':recebimento'),
                     ('LOCAL', 1, 'ENTRADA_COMPRA', ':entrada')) as m(location_kind, sinal, movement_type, sufixo)
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
  'ORDERED -> RECEIVED (D-724, D-792): recebe tudo o que ainda está pendente. Autorização (ADMIN/GESTOR) refeita internamente. Fecha o TRANSITO com RECEBIMENTO_TRANSITO e soma o mesmo no LOCAL com ENTRADA_COMPRA.';

revoke all on function public.receive_purchase_order(uuid) from public, anon;
grant execute on function public.receive_purchase_order(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Criar o SKU a partir da linha da invoice
-- ---------------------------------------------------------------------------

-- O código sem pontuação e sem zero à esquerda de número: KC0030 e KC30, EB0001
-- e EB01 dão a mesma chave. Só para AVISAR que existe parecido, nunca para
-- vincular sozinho (D-764: só o vínculo exato nasce feito).
create or replace function private.sku_code_loose_key(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'), '(^|[A-Za-z])0+([0-9])', '\1\2', 'g'));
$$;

revoke all on function private.sku_code_loose_key(text) from public, anon, authenticated;

create or replace function public.create_skus_from_import_rows(
  p_batch_id uuid,
  p_row_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  r public.purchase_import_rows;
  v_code text;
  v_sku uuid;
  v_parecido text;
  v_novo boolean;
  v_criados integer := 0;
  v_vinculados integer := 0;
  v_parecidos jsonb := '[]'::jsonb;
  v_sem_codigo integer := 0;
begin
  select organization_id into v_org from public.purchase_import_batches where id = p_batch_id;

  if v_org is null then
    raise exception 'lote de importacao % nao encontrado', p_batch_id;
  end if;

  perform private.check_purchase_order_writer(v_org);

  -- Sem lista: todas as NAO_ENCONTRADA sem vínculo do lote (o lote tem até 5000).
  -- Ambígua e provável têm candidato: só uma a uma, pela escolha do usuário.
  if p_row_ids is not null and (cardinality(p_row_ids) = 0 or cardinality(p_row_ids) > 500) then
    raise exception 'de 1 a 500 linhas por vez';
  end if;

  for r in
    select * from public.purchase_import_rows
    where batch_id = p_batch_id
      and (id = any(p_row_ids) or (p_row_ids is null and match_status = 'NAO_ENCONTRADA'))
    order by sheet_name, row_number, column_ref
    for update
  loop
    -- Linha já com SKU, já registrada ou ignorada: nada a criar.
    if r.sku_id is not null or r.resolution in ('REGISTRADA', 'IGNORADA') then
      continue;
    end if;

    v_code := nullif(btrim(coalesce(r.source_code, '')), '');

    if v_code is null or char_length(v_code) > 120 then
      v_sem_codigo := v_sem_codigo + 1;
      continue;
    end if;

    v_novo := false;

    select s.id into v_sku from public.skus s
    where s.organization_id = v_org and s.sku_key = upper(v_code);

    if v_sku is null then
      -- Parecido no catálogo: não cria — o usuário decide pela busca.
      select string_agg(s.sku, ', ' order by s.sku) into v_parecido
      from public.skus s
      where s.organization_id = v_org
        and private.sku_code_loose_key(s.sku) = private.sku_code_loose_key(v_code);

      if v_parecido is not null then
        v_parecidos := v_parecidos || jsonb_build_object('rowId', r.id, 'code', v_code, 'parecido', v_parecido);
        continue;
      end if;

      insert into public.skus (organization_id, sku, kind, title, ncm)
      values (
        v_org, v_code, 'PRODUTO',
        nullif(left(btrim(coalesce(r.source_description, '')), 500), ''),
        case when r.source_ncm ~ '^\d{8}$' then r.source_ncm end
      )
      on conflict on constraint skus_org_key_unique do nothing
      returning id into v_sku;

      if v_sku is null then
        select s.id into v_sku from public.skus s where s.organization_id = v_org and s.sku_key = upper(v_code);
      else
        v_novo := true;
        v_criados := v_criados + 1;
      end if;
    end if;

    update public.purchase_import_rows set
      sku_id = v_sku,
      resolution = 'VINCULADA',
      updated_at = now(),
      updated_by = (select auth.uid())
    where id = r.id;

    insert into public.purchase_import_row_events (organization_id, row_id, event_type, before, after, actor_user_id)
    values (
      v_org, r.id, 'RESOLVED',
      jsonb_build_object('skuId', r.sku_id, 'resolution', r.resolution),
      jsonb_build_object('skuId', v_sku, 'resolution', 'VINCULADA', 'skuCriado', v_novo, 'sku', v_code),
      (select auth.uid())
    );

    v_vinculados := v_vinculados + 1;
  end loop;

  return jsonb_build_object(
    'criados', v_criados,
    'vinculados', v_vinculados,
    'semCodigo', v_sem_codigo,
    'parecidos', v_parecidos
  );
end;
$$;

comment on function public.create_skus_from_import_rows(uuid, uuid[]) is
  'Conferência da importação (D-792): cria o SKU (código, descrição e NCM da própria linha) das linhas sem vínculo e vincula; sem lista de linhas, todas as não encontradas sem vínculo do lote. Código que já existe só vincula; código parecido com um do catálogo (sem pontuação e sem zero à esquerda) não é criado e volta em "parecidos". Grava o antes e o depois em purchase_import_row_events. Autorização ADMIN/GESTOR.';

revoke all on function public.create_skus_from_import_rows(uuid, uuid[]) from public, anon;
grant execute on function public.create_skus_from_import_rows(uuid, uuid[]) to authenticated;


-- ============================================================
-- 3. A fila de pedidos mostrava pedido em dolar como real (D-792)
-- ============================================================
-- `get_purchase_orders_overview` (D-365) somava `quantity_ordered * unit_cost`
-- sem olhar a moeda, e a tela formatava tudo em R$. Mesmo corpo, com a moeda na
-- linha e os agregados convertidos pelo cambio do pedido.
create or replace function public.get_purchase_orders_overview(
  p_organization_id uuid,
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default null,
  p_search text default null,
  p_overdue boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
-- Filtros anulaveis (`p_status is null or ...`): o plano generico nao sabe
-- qual ramo vale, e D-358 mediu o custo disso. Plano por chamada.
set plan_cache_mode = force_custom_plan
as $$
  with hoje as (
    select (now() at time zone 'America/Sao_Paulo')::date as dia
  ),
  pedidos as (
    select po.id,
           po.order_number,
           po.status,
           po.currency,
           po.exchange_rate,
           po.supplier_id,
           s.name as supplier_name,
           po.destination_warehouse_name,
           po.created_at,
           po.created_by,
           po.approved_at,
           po.ordered_at,
           po.received_at,
           po.cancelled_at,
           (po.expected_at at time zone 'UTC')::date as previsao,
           (po.expected_at at time zone 'UTC')::date - h.dia as dias_para_previsao,
           coalesce(
             po.status in ('APPROVED', 'ORDERED') and (po.expected_at at time zone 'UTC')::date < h.dia,
             false
           ) as atrasado,
           coalesce(
             po.status in ('APPROVED', 'ORDERED')
               and (po.expected_at at time zone 'UTC')::date between h.dia and h.dia + 7,
             false
           ) as chegando
    from public.purchase_orders po
    cross join hoje h
    -- `left join`: fornecedor e anulavel por desenho (rascunho sem fornecedor).
    left join public.suppliers s on s.id = po.supplier_id
    where po.organization_id = p_organization_id
      and (p_search is null
           or po.order_number::text ilike '%' || p_search || '%'
           or s.name ilike '%' || p_search || '%')
  ),
  itens as (
    select i.purchase_order_id,
           count(*) as itens,
           sum(i.quantity_ordered) as unidades,
           count(*) filter (where i.unit_cost is null) as sem_custo,
           sum(i.quantity_ordered * i.unit_cost) as soma
    from public.purchase_order_items i
    join pedidos p on p.id = i.purchase_order_id
    group by i.purchase_order_id
  ),
  completos as (
    select p.*,
           coalesce(it.itens, 0) as itens,
           coalesce(it.unidades, 0) as unidades,
           coalesce(it.sem_custo, 0) as sem_custo,
           -- Sem linha em `itens` = pedido sem item = zero sabido. Com linha,
           -- `soma` e NULL quando nenhum item tem custo (D-254).
           case when it.purchase_order_id is null then 0 else it.soma end as valor,
           -- D-792: os cartoes somam em reais. Pedido em outra moeda converte pelo
           -- cambio do proprio pedido; sem cambio, o valor em reais e desconhecido
           -- (NULL, contado em sem_custo), nunca o numero em dolar lido como real.
           case
             when it.purchase_order_id is null then 0
             when p.currency = 'BRL' then it.soma
             else it.soma * p.exchange_rate
           end as valor_brl
    from pedidos p
    left join itens it on it.purchase_order_id = p.id
  ),
  filtrados as (
    select *
    from completos c
    where (p_status is null or c.status = p_status)
      and (not coalesce(p_overdue, false) or c.atrasado)
  ),
  pagina as (
    select f.*
    from filtrados f
    order by f.created_at desc, f.order_number desc
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrados),
    'contagens', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'status', e.status,
               'pedidos', e.pedidos,
               'valor', e.valor,
               'sem_custo', e.sem_custo
             ) order by e.status), '[]'::jsonb)
      from (
        select c.status,
               count(*) as pedidos,
               sum(c.valor_brl) as valor,
               count(*) filter (where c.valor_brl is null or c.sem_custo > 0) as sem_custo
        from completos c
        group by c.status
      ) e
    ),
    'em_aberto', (
      select jsonb_build_object(
               'pedidos', count(*),
               'valor', case when count(*) = 0 then 0 else sum(c.valor_brl) end,
               'unidades', coalesce(sum(c.unidades), 0),
               'sem_custo', count(*) filter (where c.valor_brl is null or c.sem_custo > 0)
             )
      from completos c
      where c.status in ('DRAFT', 'APPROVED', 'ORDERED')
    ),
    'atrasados', (
      select jsonb_build_object(
               'pedidos', count(*),
               'valor', case when count(*) = 0 then 0 else sum(c.valor_brl) end,
               'unidades', coalesce(sum(c.unidades), 0),
               'sem_custo', count(*) filter (where c.valor_brl is null or c.sem_custo > 0),
               'maior_atraso_dias', coalesce(max(-c.dias_para_previsao), 0)
             )
      from completos c
      where c.atrasado
    ),
    'chegando', (
      select jsonb_build_object(
               'pedidos', count(*),
               'valor', case when count(*) = 0 then 0 else sum(c.valor_brl) end,
               'unidades', coalesce(sum(c.unidades), 0),
               'sem_custo', count(*) filter (where c.valor_brl is null or c.sem_custo > 0)
             )
      from completos c
      where c.chegando
    ),
    'recebidos', (
      select jsonb_build_object(
               'pedidos', count(*),
               'valor', case when count(*) = 0 then 0 else sum(c.valor_brl) end,
               'unidades', coalesce(sum(c.unidades), 0),
               'sem_custo', count(*) filter (where c.valor_brl is null or c.sem_custo > 0)
             )
      from completos c
      where c.status = 'RECEIVED'
        and c.received_at >= now() - interval '30 days'
    ),
    'linhas', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', pg.id,
               'order_number', pg.order_number,
               'status', pg.status,
               'supplier_id', pg.supplier_id,
               'supplier_name', pg.supplier_name,
               'destination_warehouse_name', pg.destination_warehouse_name,
               'created_at', pg.created_at,
               'created_by_name', pr.full_name,
               'approved_at', pg.approved_at,
               'ordered_at', pg.ordered_at,
               'received_at', pg.received_at,
               'cancelled_at', pg.cancelled_at,
               'previsao', pg.previsao,
               'dias_para_previsao', pg.dias_para_previsao,
               'atrasado', pg.atrasado,
               'itens', pg.itens,
               'unidades', pg.unidades,
               'sem_custo', pg.sem_custo,
               'valor', pg.valor,
               -- D-792: `valor` esta na moeda do pedido.
               'moeda', pg.currency
             ) order by pg.created_at desc, pg.order_number desc), '[]'::jsonb)
      from pagina pg
      -- `left join`: o perfil pode ter sido apagado e `full_name` e anulavel.
      left join public.profiles pr on pr.id = pg.created_by
    )
  )
$$;

comment on function public.get_purchase_orders_overview(uuid, integer, integer, text, text, boolean) is
  '/compras numa leitura (D-365): total filtrado, contagens por estado, em aberto, atrasados, chegando em 7 dias, recebidos em 30 dias e a pagina. Os agregados respeitam a busca e ignoram estado e "so atrasados" (D-250). Valor segue D-254: 0 sem item, NULL sem nenhum custo, soma parcial com sem_custo > 0. previsao e a data de negocio (expected_at em UTC, como o formulario grava); atraso compara com o dia de Sao Paulo e so vale para APPROVED/ORDERED. security invoker. D-792: cada linha traz valor na moeda do pedido e a moeda; os agregados somam em reais, convertendo pelo cambio do pedido, e pedido estrangeiro sem cambio conta como valor desconhecido.';

revoke all on function public.get_purchase_orders_overview(uuid, integer, integer, text, text, boolean) from public, anon;
grant execute on function public.get_purchase_orders_overview(uuid, integer, integer, text, text, boolean) to authenticated, service_role;
