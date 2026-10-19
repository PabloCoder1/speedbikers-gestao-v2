-- D-497 (b) — A nota de venda de marketplace não baixa o estoque pela
-- importação, e o motivo da recusa tem código.
--
-- A venda paga do Mercado Livre já baixa o estoque ao ser lida (`VENDA_ML`), a
-- da Shopee passa a baixar com a D-495, e a devolução do Mercado Livre já repõe
-- (`DEVOLUCAO_ML`). A NF-e da MESMA venda importada em /notas-fiscais baixaria
-- (ou reporia) de novo. O worker passa a recusar, na leitura, a nota de venda e
-- a de devolução de venda cujo intermediador (`infIntermed`, NT 2020.006) é o
-- Mercado Livre ou a Shopee; o DANFE de venda pede o XML, porque não diz o
-- intermediador. A venda de balcão, sem intermediador, continua baixando
-- (confirmado pelo dono em 19/10/2026). A regra mora em
-- `packages/domain/src/documentos/venda-de-marketplace.ts`.
--
-- Aqui, só o que o banco guarda:
--   * `intermediary_cnpj`: o CNPJ do intermediador lido do XML, para a tela e
--     para a api e o worker repetirem a guarda na confirmação e na aplicação;
--   * `last_error_code`: o motivo da recusa em código, para a tela dar o rótulo
--     e a orientação (o texto continua em `last_error`). Inclui
--     `LEITURA_NAO_GRAVADA`: a leitura que não pôde ser gravada vira FAILED com
--     o erro dito, em vez de deixar o documento em PARSING para sempre;
--   * `get_documents_overview` devolve as duas, no fim de cada linha.

alter table public.documents
  add column intermediary_cnpj text,
  add column last_error_code text;

alter table public.documents
  add constraint documents_intermediary_cnpj_check
    check (intermediary_cnpj is null or intermediary_cnpj ~ '^\d{14}$'),
  add constraint documents_last_error_code_check
    check (last_error_code is null or last_error_code in (
      'SAIDA_VENDA_MARKETPLACE', 'DEVOLUCAO_VENDA_MARKETPLACE', 'VENDA_PEDE_XML', 'LEITURA_NAO_GRAVADA'
    ));

comment on column public.documents.intermediary_cnpj is
  'CNPJ do intermediador da transacao (NF-e infIntermed/CNPJ, so com ide/indIntermed = 1; NT 2020.006). So o XML traz. D-497.';
comment on column public.documents.last_error_code is
  'O motivo da falha em codigo (D-497): SAIDA_VENDA_MARKETPLACE (nota de venda feita pelo ML ou pela Shopee, que a baixa do pedido ja cobre), DEVOLUCAO_VENDA_MARKETPLACE (a devolucao dessa venda), VENDA_PEDE_XML (DANFE de venda ou de devolucao de venda: o PDF nao diz o intermediador) e LEITURA_NAO_GRAVADA (a leitura nao pode ser gravada). NULL nas demais falhas, que so tem o texto em last_error.';

-- A tela numa leitura (D-375), com as duas colunas novas no fim de cada linha.
create or replace function public.get_documents_overview(
  p_organization_id uuid,
  p_status text default null,
  p_operation text default null,
  p_type text default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
-- Filtros anulaveis: plano por chamada (a licao de D-319/D-358).
set plan_cache_mode = force_custom_plan
as $$
  with base as (
    select d.id, d.file_name, d.status, d.operation_type, d.document_type, d.document_number,
           d.series, d.access_key, d.issuer_name, d.issuer_cnpj, d.reference, d.issue_date, d.source_format,
           d.total_items, d.resolved_items, d.created_at, d.applied_at, d.last_error,
           d.last_error_code, d.intermediary_cnpj,
           coalesce(v.valor, 0) as valor,
           coalesce(v.unidades, 0) as unidades
    from public.documents d
    left join lateral (
      select sum(i.quantity * i.unit_value) as valor, sum(i.quantity) as unidades
      from public.document_items i
      where i.document_id = d.id
    ) v on true
    where d.organization_id = p_organization_id
      and (p_search is null
           or d.file_name ilike '%' || p_search || '%'
           or d.document_number ilike '%' || p_search || '%'
           or d.issuer_name ilike '%' || p_search || '%'
           or d.access_key like '%' || p_search || '%'
           or d.reference ilike '%' || p_search || '%')
  ),
  filtrada as (
    select b.* from base b
    where (p_status is null or b.status = p_status)
      and (p_operation is null or b.operation_type = p_operation)
      and (p_type is null or b.document_type = p_type)
  ),
  pagina as (
    select f.* from filtrada f
    order by f.created_at desc
    limit greatest(coalesce(p_limit, 50), 1) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrada),
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id,
               'file_name', p.file_name,
               'status', p.status,
               'operation_type', p.operation_type,
               'document_type', p.document_type,
               'source_format', p.source_format,
               'document_number', p.document_number,
               'series', p.series,
               'access_key', p.access_key,
               'issuer_name', p.issuer_name,
               'issuer_cnpj', p.issuer_cnpj,
               'reference', p.reference,
               'issue_date', p.issue_date,
               'total_items', p.total_items,
               'resolved_items', p.resolved_items,
               'unidades', p.unidades,
               'valor', p.valor,
               'created_at', p.created_at,
               'applied_at', p.applied_at,
               'last_error', p.last_error,
               'last_error_code', p.last_error_code,
               'intermediary_cnpj', p.intermediary_cnpj
             ) order by p.created_at desc)
      from pagina p), '[]'::jsonb),
    -- As contagens respeitam a BUSCA e ignoram os recortes (D-250): clicar num
    -- cartao nao pode zerar os outros.
    'contagens', jsonb_build_object(
      'estado', (
        select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
        from (select b.status, count(*) as n from base b group by b.status) x),
      'direcao', (
        select coalesce(jsonb_object_agg(coalesce(x.operation_type, 'SEM_DIRECAO'), x.n), '{}'::jsonb)
        from (select b.operation_type, count(*) as n from base b group by b.operation_type) x),
      'tipo', (
        select coalesce(jsonb_object_agg(x.document_type, x.n), '{}'::jsonb)
        from (select coalesce(b.document_type, 'EM_LEITURA') as document_type, count(*) as n
              from base b group by 1) x)
    ),
    'resumo', (
      select jsonb_build_object(
        'total', count(*),
        'em_conferencia', count(*) filter (where b.status = 'PARSED'),
        'em_leitura', count(*) filter (where b.status in ('UPLOADED', 'PARSING', 'APPLYING')),
        'falhas', count(*) filter (where b.status = 'FAILED'),
        'aplicados_30d', count(*) filter (where b.status = 'APPLIED' and b.applied_at >= now() - interval '30 days'),
        'entradas_30d', count(*) filter (where b.status = 'APPLIED' and b.operation_type = 'ENTRADA'
                                           and b.applied_at >= now() - interval '30 days'),
        'saidas_30d', count(*) filter (where b.status = 'APPLIED' and b.operation_type = 'SAIDA'
                                         and b.applied_at >= now() - interval '30 days'),
        -- Itens sem vinculo em documentos que esperam conferencia: e o que
        -- impede de aplicar.
        'itens_sem_vinculo', coalesce(sum(greatest(coalesce(b.total_items, 0) - coalesce(b.resolved_items, 0), 0))
                                        filter (where b.status = 'PARSED'), 0))
      from base b)
  )
$$;
