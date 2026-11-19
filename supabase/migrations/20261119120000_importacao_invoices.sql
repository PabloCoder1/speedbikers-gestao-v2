-- D-767: importar invoice, proforma e "sales confirmation" de fornecedor.
--
-- A invoice tem uma LINHA por item (NCM, pedido do fornecedor, SKU,
-- descrição, quantidade, unidade, preço unitário e valor em dólar), ao
-- contrário do controle de chegada, que tem uma COLUNA por pedido. A leitura
-- continua no navegador (D-764); aqui o banco passa a guardar o que a invoice
-- traz além da quantidade e a usar no registro:
--
-- 1. purchase_import_rows ganha preço unitário, valor, moeda, unidade e o
--    cabeçalho do documento (número, data, B/L, contêiner, entrega). Tudo
--    como estava no arquivo; moeda só quando o documento a mostra.
-- 2. commit_purchase_import_group soma as linhas do mesmo SKU na mesma
--    referência (a invoice parte o mesmo item em caixas: 80 + 20) e grava o
--    custo unitário quando a moeda é uma só e o preço do SKU é um só.
--    Acrescentar a um pedido existente só leva custo na moeda do pedido.
-- 3. get_purchase_import_batch mostra preço, valor e documento, o valor total
--    do grupo e, quando a referência já tem pedido, quanto de cada SKU JÁ está
--    nele — a invoice é o embarque de um pedido, e o mesmo item não pode
--    entrar duas vezes (o banco já recusa SKU repetido no pedido, D-761).
-- 4. Corrige a chave de referência da pré-visualização: a D-764 tirava a
--    letra "s" ('s+') em vez dos espaços ('\s+'), e "js31205" não achava o
--    pedido "JS31205" que já existia.

alter table public.purchase_import_rows
  add column source_unit_price numeric(14, 4) check (source_unit_price is null or source_unit_price >= 0),
  add column source_amount numeric(14, 2) check (source_amount is null or source_amount >= 0),
  add column source_currency text check (source_currency is null or source_currency ~ '^[A-Z]{3}$'),
  add column source_unit text check (source_unit is null or char_length(source_unit) between 1 and 20),
  add column source_document jsonb check (source_document is null or jsonb_typeof(source_document) = 'object');

comment on column public.purchase_import_rows.source_unit_price is
  'Preço unitário como estava na invoice (D-767), na moeda source_currency. Nulo quando o arquivo não tem preço.';
comment on column public.purchase_import_rows.source_amount is
  'Valor da linha como estava na invoice (D-767). Não é recalculado.';
comment on column public.purchase_import_rows.source_currency is
  'Moeda do documento (D-767): só quando o arquivo mostra $ ou USD. Nula = desconhecida, e o custo não é gravado no pedido.';
comment on column public.purchase_import_rows.source_unit is
  'Unidade da invoice (PCS, SETS, PRS). A quantidade não é convertida: o usuário confere.';
comment on column public.purchase_import_rows.source_document is
  'Cabeçalho do documento de onde a linha veio (D-767): tipo, número, data, B/L, contêiner e entrega prevista, como texto e, quando legível sem ambiguidade, em ISO.';

-- O cabeçalho do documento, só com as chaves conhecidas e tamanhos limitados.
create or replace function private.purchase_import_document(p_doc jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_doc is null or jsonb_typeof(p_doc) <> 'object' then null else nullif(jsonb_strip_nulls(jsonb_build_object(
    'tipo', case when p_doc->>'tipo' in ('COMERCIAL', 'PROFORMA') then p_doc->>'tipo' end,
    'numero', left(nullif(btrim(p_doc->>'numero'), ''), 80),
    'data', left(nullif(btrim(p_doc->>'data'), ''), 40),
    'dataIso', case when (p_doc->>'dataIso') ~ '^\d{4}-\d{2}-\d{2}$' then p_doc->>'dataIso' end,
    'bl', left(nullif(btrim(p_doc->>'bl'), ''), 60),
    'container', left(nullif(btrim(p_doc->>'container'), ''), 40),
    'entrega', left(nullif(btrim(p_doc->>'entrega'), ''), 40),
    'entregaIso', case when (p_doc->>'entregaIso') ~ '^\d{4}-\d{2}-\d{2}$' then p_doc->>'entregaIso' end
  )), '{}'::jsonb) end;
$$;

revoke all on function private.purchase_import_document(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Etapa 1: o lote, agora com preço, valor, moeda, unidade e documento
-- ---------------------------------------------------------------------------

create or replace function public.create_purchase_import_batch(
  p_organization_id uuid,
  p_file_name text,
  p_file_sha256 text,
  p_sheet_names text[],
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.purchase_import_batches;
  v_count integer;
begin
  perform private.check_purchase_order_writer(p_organization_id);

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'linhas da planilha em formato inesperado';
  end if;

  v_count := jsonb_array_length(p_rows);

  if v_count = 0 then
    raise exception 'nenhuma quantidade encontrada na planilha';
  end if;

  if v_count > 5000 then
    raise exception 'no maximo 5000 quantidades por importacao (a planilha tem %)', v_count;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('po-import:' || p_organization_id::text || ':' || lower(p_file_sha256), 0));

  select * into v_batch
  from public.purchase_import_batches
  where organization_id = p_organization_id and file_sha256 = lower(p_file_sha256);

  if v_batch.id is not null then
    return jsonb_build_object('batchId', v_batch.id, 'existente', true);
  end if;

  insert into public.purchase_import_batches (organization_id, file_name, file_sha256, sheet_names, row_count, created_by)
  values (p_organization_id, btrim(p_file_name), lower(p_file_sha256), coalesce(p_sheet_names, '{}'), v_count, (select auth.uid()))
  returning * into v_batch;

  insert into public.purchase_import_rows (
    organization_id, batch_id, sheet_name, row_number, column_ref,
    source_code, source_ean, source_ncm, source_description, source_quantity_raw,
    source_reference, source_notes, raw, quantity, quantity_confirmed, match_status,
    source_unit_price, source_amount, source_currency, source_unit, source_document
  )
  select
    p_organization_id, v_batch.id,
    e->>'sheet', (e->>'row')::integer, upper(e->>'column'),
    nullif(btrim(e->>'code'), ''), nullif(btrim(e->>'ean'), ''), nullif(btrim(e->>'ncm'), ''),
    nullif(btrim(e->>'description'), ''), btrim(e->>'quantityRaw'),
    nullif(btrim(e->>'reference'), ''), nullif(btrim(e->>'notes'), ''),
    coalesce(e->'raw', '{}'::jsonb),
    -- A quantidade só nasce confirmada quando o texto era um número simples.
    case when (e->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$' and (e->>'quantity')::numeric > 0 then (e->>'quantity')::numeric end,
    coalesce((e->>'quantityNeedsConfirmation')::boolean, true) = false
      and (e->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$' and (e->>'quantity')::numeric > 0,
    'NAO_ENCONTRADA',
    case when (e->>'unitPrice') ~ '^[0-9]{1,10}(\.[0-9]+)?$' then round((e->>'unitPrice')::numeric, 4) end,
    case when (e->>'amount') ~ '^[0-9]{1,12}(\.[0-9]+)?$' then round((e->>'amount')::numeric, 2) end,
    case when upper(btrim(e->>'currency')) ~ '^[A-Z]{3}$' then upper(btrim(e->>'currency')) end,
    left(nullif(btrim(e->>'unit'), ''), 20),
    private.purchase_import_document(e->'document')
  from jsonb_array_elements(p_rows) e;

  perform private.match_purchase_import_rows(v_batch.id);

  return jsonb_build_object('batchId', v_batch.id, 'existente', false);
end;
$$;

comment on function public.create_purchase_import_batch(uuid, text, text, text[], jsonb) is
  'Etapa 1 da importação de pedidos anteriores (D-764, D-767): grava o lote e até 5000 linhas com a origem preservada — inclusive preço, valor, moeda, unidade e cabeçalho do documento quando o arquivo é uma invoice — e vincula ao catálogo em SQL (EXATA nasce vinculada; PROVAVEL, AMBIGUA e NAO_ENCONTRADA esperam o usuário). O mesmo arquivo (SHA-256) devolve o lote existente. Autorização ADMIN/GESTOR.';

-- ---------------------------------------------------------------------------
-- A pré-visualização: preço, valor, documento e o que já está no pedido
-- ---------------------------------------------------------------------------

create or replace function public.get_purchase_import_batch(
  p_batch_id uuid,
  p_filtro text default null,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with lote as (
    select b.* from public.purchase_import_batches b where b.id = p_batch_id
  ),
  base as (
    select r.*,
           coalesce(r.external_reference, r.source_reference) as referencia,
           nullif(upper(regexp_replace(coalesce(r.external_reference, r.source_reference, ''), '\s+', '', 'g')), '') as referencia_key
    from public.purchase_import_rows r
    where r.batch_id = p_batch_id
  ),
  existentes as (
    select distinct on (k.referencia_key) k.referencia_key, o.id, o.order_number, o.status, o.origin, o.supplier_id, o.currency
    from (select distinct b.referencia_key from base b where b.referencia_key is not null) k
    join public.purchase_orders o on o.organization_id = (select organization_id from lote)
      and o.external_reference_key = k.referencia_key
      and o.status <> 'CANCELLED'
    order by k.referencia_key, o.created_at
  ),
  no_pedido as (
    -- Quanto de cada SKU já está no pedido que tem a referência (D-767).
    select e.referencia_key, i.sku_id, sum(i.quantity_ordered) as quantidade
    from existentes e
    join public.purchase_order_items i on i.purchase_order_id = e.id
    where i.sku_id is not null
    group by e.referencia_key, i.sku_id
  ),
  linhas as (
    select b.*,
           count(*) filter (where b.sku_id is not null and b.resolution in ('VINCULADA', 'REGISTRADA'))
             over (partition by b.sku_id, b.referencia_key) as repeticoes_sku,
           np.quantidade as ja_no_pedido
    from base b
    left join no_pedido np on np.referencia_key = b.referencia_key and np.sku_id = b.sku_id
                          and b.resolution <> 'REGISTRADA'
  ),
  filtradas as (
    select l.* from linhas l
    where p_filtro is null
       or (p_filtro = 'PENDENTES' and l.resolution = 'PENDENTE')
       or (p_filtro = 'AMBIGUAS' and l.match_status = 'AMBIGUA' and l.resolution = 'PENDENTE')
       or (p_filtro = 'NAO_ENCONTRADAS' and l.match_status = 'NAO_ENCONTRADA' and l.resolution = 'PENDENTE')
       or (p_filtro = 'QUANTIDADE' and not l.quantity_confirmed and l.resolution not in ('IGNORADA', 'REGISTRADA'))
       or (p_filtro = 'SEM_REFERENCIA' and l.referencia_key is null and l.resolution not in ('IGNORADA', 'REGISTRADA'))
       or (p_filtro = 'VINCULADAS' and l.resolution = 'VINCULADA')
       or (p_filtro = 'REGISTRADAS' and l.resolution = 'REGISTRADA')
       or (p_filtro = 'IGNORADAS' and l.resolution = 'IGNORADA')
       or (p_filtro = 'JA_NO_PEDIDO' and l.ja_no_pedido is not null and l.resolution not in ('IGNORADA', 'REGISTRADA'))
  )
  select case when (select id from lote) is null then null else jsonb_build_object(
    'lote', (select jsonb_build_object('id', b.id, 'fileName', b.file_name, 'sheetNames', b.sheet_names,
                                       'rowCount', b.row_count, 'createdAt', b.created_at, 'createdBy', p.full_name)
             from lote b left join public.profiles p on p.id = b.created_by),
    'resumo', (
      select jsonb_build_object(
        'linhas', count(*),
        'referencias', count(distinct l.referencia_key) filter (where l.resolution <> 'IGNORADA'),
        'skus', count(distinct l.sku_id) filter (where l.resolution in ('VINCULADA', 'REGISTRADA')),
        'unidades', coalesce(sum(l.quantity) filter (where l.quantity_confirmed and l.resolution in ('VINCULADA', 'REGISTRADA')), 0),
        'exatas', count(*) filter (where l.match_status = 'EXATA'),
        'provaveis', count(*) filter (where l.match_status = 'PROVAVEL' and l.resolution = 'PENDENTE'),
        'ambiguas', count(*) filter (where l.match_status = 'AMBIGUA' and l.resolution = 'PENDENTE'),
        'nao_encontradas', count(*) filter (where l.match_status = 'NAO_ENCONTRADA' and l.resolution = 'PENDENTE'),
        'quantidade_a_confirmar', count(*) filter (where not l.quantity_confirmed and l.resolution not in ('IGNORADA', 'REGISTRADA')),
        'sem_referencia', count(*) filter (where l.referencia_key is null and l.resolution not in ('IGNORADA', 'REGISTRADA')),
        'sku_repetido_na_referencia', count(*) filter (where l.repeticoes_sku > 1 and l.resolution = 'VINCULADA'),
        'ja_no_pedido', count(*) filter (where l.ja_no_pedido is not null and l.resolution not in ('IGNORADA', 'REGISTRADA')),
        'pedidos_existentes', (select count(*) from existentes),
        'vinculadas', count(*) filter (where l.resolution = 'VINCULADA'),
        'registradas', count(*) filter (where l.resolution = 'REGISTRADA'),
        'ignoradas', count(*) filter (where l.resolution = 'IGNORADA'))
      from linhas l),
    'grupos', coalesce((
      select jsonb_agg(g order by g->>'referencia' nulls first)
      from (
        select jsonb_build_object(
          'referencia', min(l.referencia),
          'referenciaKey', l.referencia_key,
          'linhas', count(*),
          'vinculadas', count(*) filter (where l.resolution = 'VINCULADA'),
          'pendentes', count(*) filter (where l.resolution = 'PENDENTE'),
          'registradas', count(*) filter (where l.resolution = 'REGISTRADA'),
          'quantidadeAConfirmar', count(*) filter (where l.resolution = 'VINCULADA' and not l.quantity_confirmed),
          'skuRepetido', count(*) filter (where l.resolution = 'VINCULADA' and l.repeticoes_sku > 1),
          'jaNoPedido', count(*) filter (where l.resolution = 'VINCULADA' and l.ja_no_pedido is not null),
          'unidades', coalesce(sum(l.quantity) filter (where l.resolution = 'VINCULADA' and l.quantity_confirmed), 0),
          -- Valor da invoice: só com uma moeda no grupo; moedas misturadas não se somam.
          'moeda', case when count(distinct l.source_currency) filter (where l.source_amount is not null) = 1
                        then min(l.source_currency) filter (where l.source_amount is not null) end,
          'valor', case when count(distinct l.source_currency) filter (where l.source_amount is not null) = 1
                        then sum(l.source_amount) filter (where l.resolution in ('VINCULADA', 'PENDENTE', 'REGISTRADA')) end,
          'documento', (array_agg(l.source_document order by l.sheet_name, l.row_number) filter (where l.source_document is not null))[1],
          'abas', array_agg(distinct l.sheet_name),
          'pedidoExistente', (select jsonb_build_object('id', e.id, 'orderNumber', e.order_number, 'status', e.status,
                                                        'origin', e.origin, 'currency', e.currency)
                              from existentes e where e.referencia_key = l.referencia_key),
          'pedidoRegistrado', (select jsonb_build_object('id', o.id, 'orderNumber', o.order_number, 'status', o.status)
                               from public.purchase_orders o
                               where o.id = (select min(x.purchase_order_id::text)::uuid from linhas x
                                             where x.referencia_key is not distinct from l.referencia_key and x.purchase_order_id is not null))
        ) as g
        from linhas l
        where l.resolution <> 'IGNORADA'
        group by l.referencia_key
      ) q), '[]'::jsonb),
    'total', (select count(*) from filtradas),
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'sheet', f.sheet_name, 'row', f.row_number, 'column', f.column_ref,
               'code', f.source_code, 'ean', f.source_ean, 'ncm', f.source_ncm, 'description', f.source_description,
               'quantityRaw', f.source_quantity_raw, 'sourceReference', f.source_reference, 'notes', f.source_notes,
               'quantity', f.quantity, 'quantityConfirmed', f.quantity_confirmed,
               'externalReference', f.external_reference, 'referencia', f.referencia,
               'matchStatus', f.match_status, 'candidates', f.match_candidates,
               'skuId', f.sku_id, 'sku', s.sku, 'skuTitle', s.title,
               'resolution', f.resolution, 'purchaseOrderId', f.purchase_order_id,
               'skuRepetido', f.repeticoes_sku > 1,
               'unitPrice', f.source_unit_price, 'amount', f.source_amount, 'currency', f.source_currency,
               'unit', f.source_unit, 'jaNoPedido', f.ja_no_pedido)
             order by f.sheet_name, f.row_number, f.column_ref)
      from (select * from filtradas order by sheet_name, row_number, column_ref
            limit least(greatest(p_limit, 0), 500) offset greatest(p_offset, 0)) f
      left join public.skus s on s.id = f.sku_id), '[]'::jsonb)
  ) end;
$$;

comment on function public.get_purchase_import_batch(uuid, text, integer, integer) is
  'A pré-visualização da importação (D-764, D-767): resumo (referências, SKUs, unidades confirmadas, exatas, prováveis, ambíguas, não encontradas, quantidades a confirmar, sem referência, SKU repetido na referência, linhas cujo SKU já está no pedido da referência, pedidos que já existem), os grupos por referência — com valor e moeda da invoice e o cabeçalho do documento — e as linhas filtradas, até 500 por página. Tudo agregado aqui. security invoker (ADMIN/GESTOR pela RLS).';

-- ---------------------------------------------------------------------------
-- Etapa 3: registrar a referência — mesmo SKU somado, custo na moeda certa
-- ---------------------------------------------------------------------------

create or replace function public.commit_purchase_import_group(
  p_batch_id uuid,
  p_reference text,
  p_situacao text,
  p_supplier_id uuid default null,
  p_expected_at timestamptz default null,
  p_supplier_ordered_on date default null,
  p_stage text default null,
  p_confirm_new boolean default false,
  p_target_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.purchase_import_batches;
  v_key text := private.purchase_reference_key(p_reference);
  v_items jsonb;
  v_result jsonb;
  v_order_id uuid;
  v_n integer;
  v_moeda text;
  v_moeda_pedido text;
begin
  select * into v_batch from public.purchase_import_batches where id = p_batch_id;

  if v_batch.id is null then
    raise exception 'lote de importacao % nao encontrado', p_batch_id;
  end if;

  perform private.check_purchase_order_writer(v_batch.organization_id);

  if v_key is null then
    raise exception 'informe a referencia do pedido antes de registrar';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('po-import-commit:' || p_batch_id::text || ':' || v_key, 0));

  -- As linhas desta referência prontas: vinculadas, quantidade confirmada.
  if exists (
    select 1 from public.purchase_import_rows r
    where r.batch_id = p_batch_id
      and private.purchase_reference_key(coalesce(r.external_reference, r.source_reference)) = v_key
      and r.resolution = 'VINCULADA'
      and not r.quantity_confirmed
  ) then
    raise exception 'confirme as quantidades da referencia % antes de registrar', p_reference;
  end if;

  -- A moeda do grupo: uma só entre as linhas com preço; senão o custo não é gravado.
  select case when count(distinct r.source_currency) = 1 and bool_and(r.source_currency is not null)
              then min(r.source_currency) end
  into v_moeda
  from public.purchase_import_rows r
  where r.batch_id = p_batch_id
    and private.purchase_reference_key(coalesce(r.external_reference, r.source_reference)) = v_key
    and r.resolution = 'VINCULADA'
    and r.source_unit_price is not null;

  if p_target_order_id is not null then
    select o.currency into v_moeda_pedido
    from public.purchase_orders o
    where o.id = p_target_order_id and o.organization_id = v_batch.organization_id;

    -- Custo só na moeda do pedido que recebe os itens.
    if v_moeda_pedido is distinct from v_moeda then
      v_moeda := null;
    end if;
  end if;

  -- O mesmo SKU em várias linhas da referência é o mesmo item partido (80 + 20): soma.
  -- Custo unitário só quando todas as linhas do SKU têm o mesmo preço.
  select jsonb_agg(jsonb_build_object(
           'skuId', g.sku_id,
           'quantity', g.quantidade,
           'unitCost', case when v_moeda is not null and g.precos = 1 and g.com_preco = g.linhas then g.preco end)
         order by g.primeira),
         count(*)
  into v_items, v_n
  from (
    select r.sku_id,
           sum(r.quantity) as quantidade,
           count(distinct r.source_unit_price) as precos,
           count(r.source_unit_price) as com_preco,
           count(*) as linhas,
           min(r.source_unit_price) as preco,
           min(lpad(r.row_number::text, 8, '0') || r.sheet_name || r.column_ref) as primeira
    from public.purchase_import_rows r
    where r.batch_id = p_batch_id
      and private.purchase_reference_key(coalesce(r.external_reference, r.source_reference)) = v_key
      and r.resolution = 'VINCULADA'
    group by r.sku_id
  ) g;

  if coalesce(v_n, 0) = 0 then
    -- Nada novo: a referência já foi registrada (idempotência) ou não tem linha pronta.
    return jsonb_build_object('resultado', 'NADA_A_REGISTRAR', 'pedido', null, 'candidatos', '[]'::jsonb);
  end if;

  if p_target_order_id is not null then
    -- Acrescentar ao pedido externo que já existe com esta referência.
    if not exists (
      select 1 from public.purchase_orders o
      where o.id = p_target_order_id and o.organization_id = v_batch.organization_id
        and o.external_reference_key = v_key
    ) then
      raise exception 'o pedido escolhido nao tem a referencia %', p_reference;
    end if;

    perform public.add_purchase_order_items_placed(
      p_target_order_id, v_items,
      md5('po-import-add:' || p_batch_id::text || ':' || v_key)::uuid
    );
    v_order_id := p_target_order_id;
    v_result := jsonb_build_object(
      'resultado', 'ACRESCENTADO',
      'pedido', (select jsonb_build_object('id', o.id, 'orderNumber', o.order_number, 'status', o.status)
                 from public.purchase_orders o where o.id = p_target_order_id),
      'candidatos', '[]'::jsonb);
  else
    v_result := public.register_placed_purchase_order(
      p_organization_id => v_batch.organization_id,
      p_request_id => md5('po-import:' || p_batch_id::text || ':' || v_key)::uuid,
      p_items => v_items,
      p_situacao => p_situacao,
      p_origin => 'PLANILHA',
      p_supplier_id => p_supplier_id,
      p_external_reference => btrim(p_reference),
      p_supplier_ordered_on => p_supplier_ordered_on,
      p_expected_at => p_expected_at,
      p_stage => p_stage,
      p_notes => 'Importado de ' || v_batch.file_name,
      p_currency => v_moeda,
      p_is_import => true,
      p_confirm_new => p_confirm_new
    );

    if v_result->>'resultado' not in ('CRIADO', 'JA_REGISTRADO') then
      return v_result;
    end if;

    v_order_id := (v_result->'pedido'->>'id')::uuid;
  end if;

  with feitas as (
    update public.purchase_import_rows r set
      resolution = 'REGISTRADA',
      purchase_order_id = v_order_id,
      purchase_order_item_id = (
        select i.id from public.purchase_order_items i
        where i.purchase_order_id = v_order_id and i.sku_id = r.sku_id
        order by i.position limit 1),
      updated_at = now(),
      updated_by = (select auth.uid())
    where r.batch_id = p_batch_id
      and private.purchase_reference_key(coalesce(r.external_reference, r.source_reference)) = v_key
      and r.resolution = 'VINCULADA'
    returning r.id, r.organization_id
  )
  insert into public.purchase_import_row_events (organization_id, row_id, event_type, after, actor_user_id)
  select f.organization_id, f.id, 'REGISTERED', jsonb_build_object('purchaseOrderId', v_order_id), (select auth.uid())
  from feitas f;

  return v_result;
end;
$$;

comment on function public.commit_purchase_import_group(uuid, text, text, uuid, timestamptz, date, text, boolean, uuid) is
  'Etapa 3 da importação (D-764, D-767): as linhas VINCULADAS de uma referência viram um pedido pelo register_placed_purchase_order (origem PLANILHA, situação escolhida pelo usuário), com requisição determinística por lote e referência — gravar de novo não duplica. Linhas do mesmo SKU são somadas num item; o custo unitário entra quando a moeda do grupo é uma só e o SKU tem um preço só (e, ao acrescentar, só na moeda do pedido). Com p_target_order_id, acrescenta ao pedido externo que já tem a referência — SKU que já está no pedido é recusado. Exige quantidade confirmada. Devolve o resultado do registro (inclusive POSSIVEL_DUPLICIDADE). Autorização ADMIN/GESTOR.';
