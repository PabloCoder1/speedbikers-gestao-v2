-- D-764: importar pedidos anteriores de planilha, em etapas e sem inventar.
--
-- A planilha é lida NO NAVEGADOR (só as partes de dados do .xlsx; as imagens
-- incorporadas nunca são descompactadas) e chega aqui como linhas com a origem
-- preservada: arquivo, aba, linha, coluna e o texto original. Nada vira pedido
-- na leitura. O caminho é:
--
--   1. create_purchase_import_batch   — o lote e as linhas; a vinculação ao
--      catálogo é feita AQUI, em SQL (exata, provável, ambígua, não
--      encontrada). O mesmo arquivo (SHA-256) devolve o lote que já existe.
--   2. resolve_purchase_import_rows   — o usuário confirma vínculo,
--      quantidade e referência; cada correção fica no histórico.
--   3. commit_purchase_import_group   — uma referência por vez vira pedido
--      pelo `register_placed_purchase_order` (D-761), com a situação que o
--      usuário escolheu (planejado ou pedido realizado — nunca ORDERED por
--      padrão) e requisição determinística: gravar duas vezes não duplica.
--
-- Regras de vinculação (nenhuma é automática além da exata):
--   EXATA          o código é o SKU (sem caixa e espaço nas pontas) de UM
--                  produto, e o EAN — quando válido e cadastrado — não aponta
--                  para outro.
--   PROVAVEL       um só candidato pelo código sem pontuação, pelo código do
--                  fornecedor (supplier_skus, D-723) ou só pelo EAN válido.
--   AMBIGUA        mais de um candidato, EAN e código em produtos diferentes,
--                  ou o mesmo código com descrições diferentes no arquivo
--                  (o KPP08 do modelo).
--   NAO_ENCONTRADA nenhum candidato.
-- Kit continua kit: a linha vincula ao SKU do kit, nunca aos componentes.

create table public.purchase_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  file_name text not null check (char_length(btrim(file_name)) between 1 and 255),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  sheet_names text[] not null default '{}',
  row_count integer not null default 0 check (row_count >= 0),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint purchase_import_batches_file_unique unique (organization_id, file_sha256)
);

comment on table public.purchase_import_batches is
  'Lote de importação de pedidos anteriores (D-764): um arquivo, identificado pelo SHA-256 do conteúdo. O mesmo arquivo importado de novo devolve este lote.';

create table public.purchase_import_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null references public.purchase_import_batches(id) on delete cascade,

  -- A origem, como estava no arquivo.
  sheet_name text not null check (char_length(sheet_name) between 1 and 100),
  row_number integer not null check (row_number >= 1),
  column_ref text not null check (column_ref ~ '^[A-Z]{1,3}$'),
  source_code text check (source_code is null or char_length(source_code) <= 120),
  source_ean text check (source_ean is null or char_length(source_ean) <= 40),
  source_ncm text check (source_ncm is null or char_length(source_ncm) <= 20),
  source_description text check (source_description is null or char_length(source_description) <= 500),
  source_quantity_raw text not null check (char_length(source_quantity_raw) between 1 and 120),
  source_reference text check (source_reference is null or char_length(source_reference) <= 80),
  source_notes text check (source_notes is null or char_length(source_notes) <= 500),
  raw jsonb not null default '{}'::jsonb,

  -- O que o usuário confirma.
  quantity numeric(14, 3) check (quantity is null or quantity > 0),
  quantity_confirmed boolean not null default false,
  external_reference text check (external_reference is null or char_length(btrim(external_reference)) between 1 and 80),

  match_status text not null check (match_status in ('EXATA', 'PROVAVEL', 'AMBIGUA', 'NAO_ENCONTRADA')),
  match_candidates jsonb not null default '[]'::jsonb,
  sku_id uuid references public.skus(id) on delete set null,
  resolution text not null default 'PENDENTE'
    check (resolution in ('PENDENTE', 'VINCULADA', 'IGNORADA', 'REGISTRADA')),

  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  purchase_order_item_id uuid references public.purchase_order_items(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,

  constraint purchase_import_rows_origin_unique unique (batch_id, sheet_name, row_number, column_ref),
  constraint purchase_import_rows_linked_has_sku check (resolution not in ('VINCULADA', 'REGISTRADA') or sku_id is not null),
  constraint purchase_import_rows_confirmed_has_quantity check (not quantity_confirmed or quantity is not null)
);

comment on table public.purchase_import_rows is
  'Uma quantidade lida da planilha (D-764): a célula (aba, linha, coluna) com o texto original preservado, o vínculo ao catálogo e o que o usuário confirmou. Linha não vinculada fica salva para conciliar depois; IGNORADA não apaga nada.';

create index purchase_import_rows_batch_idx on public.purchase_import_rows (batch_id, sheet_name, row_number, column_ref);
create index purchase_import_rows_order_idx on public.purchase_import_rows (purchase_order_id) where purchase_order_id is not null;

create table public.purchase_import_row_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  row_id uuid not null references public.purchase_import_rows(id) on delete cascade,
  event_type text not null check (event_type in ('RESOLVED', 'REGISTERED')),
  before jsonb not null default '{}'::jsonb,
  after jsonb not null default '{}'::jsonb,
  actor_user_id uuid references public.profiles(id) on delete set null,
  occurred_at timestamptz not null default now()
);

comment on table public.purchase_import_row_events is
  'Histórico append-only das correções de vínculo, quantidade e referência de cada linha importada (D-764). Corrigir não apaga o que era.';

create index purchase_import_row_events_row_idx on public.purchase_import_row_events (row_id, occurred_at);

alter table public.purchase_import_batches enable row level security;
alter table public.purchase_import_rows enable row level security;
alter table public.purchase_import_row_events enable row level security;

create policy purchase_import_batches_select_permitted on public.purchase_import_batches
  for select to authenticated using (private.has_org_role(organization_id, array['ADMIN', 'GESTOR']));
create policy purchase_import_rows_select_permitted on public.purchase_import_rows
  for select to authenticated using (private.has_org_role(organization_id, array['ADMIN', 'GESTOR']));
create policy purchase_import_row_events_select_permitted on public.purchase_import_row_events
  for select to authenticated using (private.has_org_role(organization_id, array['ADMIN', 'GESTOR']));

-- Escrita só pelas funções abaixo, que refazem a autorização.
revoke all on public.purchase_import_batches, public.purchase_import_rows, public.purchase_import_row_events from anon, authenticated;
grant select on public.purchase_import_batches, public.purchase_import_rows, public.purchase_import_row_events to authenticated;

-- ---------------------------------------------------------------------------
-- Ajudantes
-- ---------------------------------------------------------------------------

-- GTIN-8/12/13/14 com dígito verificador. EAN inválido nunca vincula.
create or replace function private.gtin_is_valid(p_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with d as (select regexp_replace(coalesce(p_code, ''), '\s', '', 'g') as code)
  select case
    when d.code !~ '^[0-9]+$' or char_length(d.code) not in (8, 12, 13, 14) or d.code ~ '^0+$' then false
    else (
      select (10 - (sum(
               substr(d.code, char_length(d.code) - k, 1)::int * case when k % 2 = 1 then 3 else 1 end
             ) % 10)) % 10 = right(d.code, 1)::int
      from generate_series(1, char_length(d.code) - 1) k
    )
  end
  from d;
$$;

revoke all on function private.gtin_is_valid(text) from public, anon, authenticated;

create or replace function private.import_code_key(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$ select nullif(upper(btrim(coalesce(p_code, ''))), ''); $$;

create or replace function private.import_code_compact(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$ select nullif(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), ''); $$;

create or replace function private.import_text_key(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$ select nullif(upper(regexp_replace(btrim(coalesce(p_text, '')), '\s+', ' ', 'g')), ''); $$;

revoke all on function private.import_code_key(text) from public, anon, authenticated;
revoke all on function private.import_code_compact(text) from public, anon, authenticated;
revoke all on function private.import_text_key(text) from public, anon, authenticated;

-- A vinculação das linhas de um lote ao catálogo, em SQL e de uma vez.
create or replace function private.match_purchase_import_rows(p_batch_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.purchase_import_batches where id = p_batch_id;

  with linha as (
    select
      r.id,
      private.import_code_key(r.source_code) as code_key,
      private.import_code_compact(r.source_code) as code_compact,
      case when private.gtin_is_valid(r.source_ean) then regexp_replace(r.source_ean, '\s', '', 'g') end as ean
    from public.purchase_import_rows r
    where r.batch_id = p_batch_id and r.resolution = 'PENDENTE'
  ),
  -- O mesmo código com descrições diferentes no arquivo: ambíguo por si.
  conflito as (
    select private.import_code_key(r.source_code) as code_key
    from public.purchase_import_rows r
    where r.batch_id = p_batch_id and private.import_code_key(r.source_code) is not null
    group by 1
    having count(distinct private.import_text_key(r.source_description)) > 1
  ),
  candidatos as (
    select l.id, s.id as sku_id, s.sku, s.title, s.kind, s.barcode, 'CODIGO' as via
    from linha l
    join public.skus s on s.organization_id = v_org and s.sku_key = l.code_key
    union
    select l.id, s.id, s.sku, s.title, s.kind, s.barcode, 'CODIGO_SEM_PONTUACAO'
    from linha l
    join public.skus s on s.organization_id = v_org
      and l.code_compact is not null
      and private.import_code_compact(s.sku) = l.code_compact
      and s.sku_key is distinct from l.code_key
    union
    select l.id, s.id, s.sku, s.title, s.kind, s.barcode, 'CODIGO_FORNECEDOR'
    from linha l
    join public.supplier_skus ss on ss.organization_id = v_org and private.import_code_key(ss.supplier_code) = l.code_key
    join public.skus s on s.id = ss.sku_id
    union
    select l.id, s.id, s.sku, s.title, s.kind, s.barcode, 'EAN'
    from linha l
    join public.skus s on s.organization_id = v_org
      and l.ean is not null
      and regexp_replace(coalesce(s.barcode, ''), '\s', '', 'g') = l.ean
  ),
  resumo as (
    select
      l.id,
      l.code_key,
      (select count(distinct c.sku_id) from candidatos c where c.id = l.id and c.via = 'CODIGO') as n_codigo,
      (select count(distinct c.sku_id) from candidatos c where c.id = l.id) as n_total,
      (select min(c.sku_id::text) from candidatos c where c.id = l.id and c.via = 'CODIGO') as sku_codigo,
      (select min(c.sku_id::text) from candidatos c where c.id = l.id) as sku_unico,
      exists (select 1 from conflito k where k.code_key = l.code_key) as conflito_arquivo,
      coalesce((
        select jsonb_agg(jsonb_build_object(
                 'skuId', g.sku_id, 'sku', g.sku, 'title', g.title, 'kit', g.kind = 'KIT', 'via', g.vias)
               order by g.sku)
        from (
          select c.sku_id, c.sku, c.title, c.kind, array_agg(distinct c.via order by c.via) as vias
          from candidatos c where c.id = l.id
          group by c.sku_id, c.sku, c.title, c.kind
        ) g), '[]'::jsonb) as lista
    from linha l
  )
  update public.purchase_import_rows r set
    match_candidates = s.lista,
    match_status = case
      when s.conflito_arquivo then 'AMBIGUA'
      when s.n_codigo = 1 and s.n_total = 1 then 'EXATA'
      -- Código exato num produto e EAN/código de fornecedor em outro: ambíguo.
      when s.n_codigo = 1 then 'AMBIGUA'
      when s.n_codigo > 1 then 'AMBIGUA'
      when s.n_total = 1 then 'PROVAVEL'
      when s.n_total > 1 then 'AMBIGUA'
      else 'NAO_ENCONTRADA'
    end,
    -- Só a exata nasce vinculada; a provável fica como sugestão até o clique.
    sku_id = case when not s.conflito_arquivo and s.n_codigo = 1 and s.n_total = 1 then s.sku_codigo::uuid end,
    resolution = case when not s.conflito_arquivo and s.n_codigo = 1 and s.n_total = 1 then 'VINCULADA' else 'PENDENTE' end
  from resumo s
  where r.id = s.id;
end;
$$;

revoke all on function private.match_purchase_import_rows(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. O lote
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
    source_reference, source_notes, raw, quantity, quantity_confirmed, match_status
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
    'NAO_ENCONTRADA'
  from jsonb_array_elements(p_rows) e;

  perform private.match_purchase_import_rows(v_batch.id);

  return jsonb_build_object('batchId', v_batch.id, 'existente', false);
end;
$$;

comment on function public.create_purchase_import_batch(uuid, text, text, text[], jsonb) is
  'Etapa 1 da importação de pedidos anteriores (D-764): grava o lote e até 5000 linhas com a origem preservada e vincula ao catálogo em SQL (EXATA nasce vinculada; PROVAVEL, AMBIGUA e NAO_ENCONTRADA esperam o usuário). O mesmo arquivo (SHA-256) devolve o lote existente. Autorização ADMIN/GESTOR.';

revoke all on function public.create_purchase_import_batch(uuid, text, text, text[], jsonb) from public, anon;
grant execute on function public.create_purchase_import_batch(uuid, text, text, text[], jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- A leitura do lote: resumo, grupos por referência e linhas (paginadas)
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
  linhas as (
    select r.*,
           coalesce(r.external_reference, r.source_reference) as referencia,
           nullif(upper(regexp_replace(coalesce(r.external_reference, r.source_reference, ''), 's+', '', 'g')), '') as referencia_key,
           count(*) filter (where r.sku_id is not null and r.resolution in ('VINCULADA', 'REGISTRADA'))
             over (partition by r.sku_id, nullif(upper(regexp_replace(coalesce(r.external_reference, r.source_reference, ''), 's+', '', 'g')), '')) as repeticoes_sku
    from public.purchase_import_rows r
    where r.batch_id = p_batch_id
  ),
  existentes as (
    select distinct on (l.referencia_key) l.referencia_key, o.id, o.order_number, o.status, o.origin, o.supplier_id
    from linhas l
    join public.purchase_orders o on o.organization_id = (select organization_id from lote)
      and o.external_reference_key = l.referencia_key
      and o.status <> 'CANCELLED'
    where l.referencia_key is not null
    order by l.referencia_key, o.created_at
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
          'unidades', coalesce(sum(l.quantity) filter (where l.resolution = 'VINCULADA' and l.quantity_confirmed), 0),
          'abas', array_agg(distinct l.sheet_name),
          'pedidoExistente', (select jsonb_build_object('id', e.id, 'orderNumber', e.order_number, 'status', e.status, 'origin', e.origin)
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
               'skuRepetido', f.repeticoes_sku > 1)
             order by f.sheet_name, f.row_number, f.column_ref)
      from (select * from filtradas order by sheet_name, row_number, column_ref
            limit least(greatest(p_limit, 0), 500) offset greatest(p_offset, 0)) f
      left join public.skus s on s.id = f.sku_id), '[]'::jsonb)
  ) end;
$$;

comment on function public.get_purchase_import_batch(uuid, text, integer, integer) is
  'A pré-visualização da importação (D-764): resumo (referências, SKUs, unidades confirmadas, exatas, prováveis, ambíguas, não encontradas, quantidades a confirmar, sem referência, SKU repetido na referência, pedidos que já existem), os grupos por referência e as linhas filtradas, até 500 por página. Tudo agregado aqui. security invoker (ADMIN/GESTOR pela RLS).';

revoke all on function public.get_purchase_import_batch(uuid, text, integer, integer) from public, anon;
grant execute on function public.get_purchase_import_batch(uuid, text, integer, integer) to authenticated;

create or replace function public.get_purchase_import_batches(p_organization_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'fileName', b.file_name, 'rowCount', b.row_count, 'createdAt', b.created_at,
           'registradas', (select count(*) from public.purchase_import_rows r where r.batch_id = b.id and r.resolution = 'REGISTRADA'),
           'pendentes', (select count(*) from public.purchase_import_rows r where r.batch_id = b.id and r.resolution in ('PENDENTE', 'VINCULADA')))
         order by b.created_at desc), '[]'::jsonb)
  from (select * from public.purchase_import_batches
        where organization_id = p_organization_id
        order by created_at desc limit 50) b;
$$;

revoke all on function public.get_purchase_import_batches(uuid) from public, anon;
grant execute on function public.get_purchase_import_batches(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. As correções do usuário
-- ---------------------------------------------------------------------------

create or replace function public.resolve_purchase_import_rows(p_batch_id uuid, p_changes jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  ch jsonb;
  r public.purchase_import_rows;
  v_sku uuid;
  v_qty numeric;
  v_confirmed boolean;
  v_ref text;
  v_resolution text;
  v_n integer := 0;
begin
  select organization_id into v_org from public.purchase_import_batches where id = p_batch_id;

  if v_org is null then
    raise exception 'lote de importacao % nao encontrado', p_batch_id;
  end if;

  perform private.check_purchase_order_writer(v_org);

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 500 then
    raise exception 'ate 500 correcoes por vez';
  end if;

  for ch in select * from jsonb_array_elements(p_changes)
  loop
    select * into r from public.purchase_import_rows
    where id = (ch->>'rowId')::uuid and batch_id = p_batch_id
    for update;

    if r.id is null then
      raise exception 'linha % nao pertence ao lote', ch->>'rowId';
    end if;

    if r.resolution = 'REGISTRADA' then
      raise exception 'a linha % da aba % ja virou pedido: corrija pela tela do pedido', r.row_number, r.sheet_name;
    end if;

    v_sku := case when ch ? 'skuId' then nullif(ch->>'skuId', '')::uuid else r.sku_id end;
    v_qty := case when ch ? 'quantity' then nullif(ch->>'quantity', '')::numeric else r.quantity end;
    v_confirmed := case when ch ? 'quantityConfirmed' then (ch->>'quantityConfirmed')::boolean else r.quantity_confirmed end;
    v_ref := case when ch ? 'externalReference' then nullif(btrim(coalesce(ch->>'externalReference', '')), '') else r.external_reference end;
    v_resolution := coalesce(nullif(ch->>'resolution', ''),
                             case when v_sku is null then 'PENDENTE' else 'VINCULADA' end);

    if v_resolution not in ('PENDENTE', 'VINCULADA', 'IGNORADA') then
      raise exception 'resolucao % invalida', v_resolution;
    end if;

    if v_sku is not null and not exists (select 1 from public.skus s where s.id = v_sku and s.organization_id = v_org) then
      raise exception 'SKU nao encontrado nesta organizacao';
    end if;

    if v_resolution = 'VINCULADA' and v_sku is null then
      raise exception 'escolha o SKU antes de vincular a linha % da aba %', r.row_number, r.sheet_name;
    end if;

    if v_qty is not null and v_qty <= 0 then
      raise exception 'quantidade precisa ser positiva';
    end if;

    if v_confirmed and v_qty is null then
      raise exception 'informe a quantidade antes de confirmar';
    end if;

    update public.purchase_import_rows set
      sku_id = v_sku,
      quantity = v_qty,
      quantity_confirmed = v_confirmed,
      external_reference = v_ref,
      resolution = v_resolution,
      updated_at = now(),
      updated_by = (select auth.uid())
    where id = r.id;

    insert into public.purchase_import_row_events (organization_id, row_id, event_type, before, after, actor_user_id)
    values (
      v_org, r.id, 'RESOLVED',
      jsonb_build_object('skuId', r.sku_id, 'quantity', r.quantity, 'quantityConfirmed', r.quantity_confirmed,
                         'externalReference', r.external_reference, 'resolution', r.resolution),
      jsonb_build_object('skuId', v_sku, 'quantity', v_qty, 'quantityConfirmed', v_confirmed,
                         'externalReference', v_ref, 'resolution', v_resolution),
      (select auth.uid())
    );

    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

comment on function public.resolve_purchase_import_rows(uuid, jsonb) is
  'Etapa 2 da importação (D-764): [{rowId, skuId?, quantity?, quantityConfirmed?, externalReference?, resolution?}]. Vincula, confirma quantidade, dá a referência a uma coluna sem cabeçalho ou ignora — e grava o antes e o depois em purchase_import_row_events. Linha já registrada é recusada. Autorização ADMIN/GESTOR.';

revoke all on function public.resolve_purchase_import_rows(uuid, jsonb) from public, anon;
grant execute on function public.resolve_purchase_import_rows(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Gravar uma referência como pedido
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

  if exists (
    select 1 from public.purchase_import_rows r
    where r.batch_id = p_batch_id
      and private.purchase_reference_key(coalesce(r.external_reference, r.source_reference)) = v_key
      and r.resolution = 'VINCULADA'
    group by r.sku_id having count(*) > 1
  ) then
    raise exception 'o mesmo SKU aparece em mais de uma linha da referencia %: ignore uma ou some numa so', p_reference;
  end if;

  select jsonb_agg(jsonb_build_object('skuId', r.sku_id, 'quantity', r.quantity) order by r.sheet_name, r.row_number, r.column_ref),
         count(*)
  into v_items, v_n
  from public.purchase_import_rows r
  where r.batch_id = p_batch_id
    and private.purchase_reference_key(coalesce(r.external_reference, r.source_reference)) = v_key
    and r.resolution = 'VINCULADA';

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
  'Etapa 3 da importação (D-764): as linhas VINCULADAS de uma referência viram um pedido pelo register_placed_purchase_order (origem PLANILHA, situação escolhida pelo usuário), com requisição determinística por lote e referência — gravar de novo não duplica. Com p_target_order_id, acrescenta ao pedido externo que já tem a referência. Exige quantidade confirmada e SKU sem repetição. Devolve o resultado do registro (inclusive POSSIVEL_DUPLICIDADE). Autorização ADMIN/GESTOR.';

revoke all on function public.commit_purchase_import_group(uuid, text, text, uuid, timestamptz, date, text, boolean, uuid) from public, anon;
grant execute on function public.commit_purchase_import_group(uuid, text, text, uuid, timestamptz, date, text, boolean, uuid) to authenticated;
