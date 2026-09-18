-- ============================================================
-- D-375 -- entrada e saida por XML e por PDF, e /notas-fiscais numa leitura.
--
-- O pedido do dono: "essa tela tem que dar pra dar entrada e saida, tanto por
-- xml quanto por pdf", com quatro arquivos de exemplo: o XML e o DANFE da mesma
-- nota de entrada, o "Pedido de Saida" impresso do UpSeller e as instrucoes de
-- preparacao de um envio ao Full do Mercado Livre.
--
-- Ate aqui `documents` so aceitava NF-e/XML (`document_type check (... 'NFE')`)
-- e `document_items` exigia unidade e valor -- o que o DANFE tem, mas o pedido
-- de saida e o envio ao Full NAO tem (eles trazem SKU e quantidade, que e o que
-- o ledger precisa).
--
-- O que esta migration faz:
--
--   1. `document_type` passa a aceitar os quatro layouts;
--   2. `document_items.unit`, `unit_value` e `total_value` viram ANULAVEIS --
--      ausencia de valor e o estado normal de um documento de separacao, e
--      gravar zero ali seria afirmar "de graca" (a licao de D-254 aplicada aqui);
--   3. `documents.reference` guarda a linha que explica o documento a quem
--      confere ("Armazem ESTOQUE LOJA · ENVIO FULL #77375684 CONTA 1");
--   4. `stock_movements.movement_type` ganha `SAIDA_DOCUMENTO`: a saida por
--      documento NAO fiscal existe e nao pode ser gravada como `SAIDA_NFE`, que
--      afirmaria uma nota que ninguem emitiu;
--   5. `get_documents_overview` -- a tela numa leitura: pagina, total filtrado,
--      contagens por estado/direcao/tipo e o resumo (em conferencia, aplicados
--      nos ultimos 30 dias, falhas).
--
-- O ciclo (UPLOADED -> PARSING -> PARSED -> APPLYING -> APPLIED, com FAILED e
-- CANCELLED) nao muda, nem o vinculo humano item->SKU antes de aplicar (D-133,
-- docs/NFE.md secao 3).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Os quatro layouts
-- ------------------------------------------------------------
alter table public.documents drop constraint documents_document_type_check;

-- O tipo so e conhecido DEPOIS de ler o conteudo: um PDF pode ser DANFE, pedido
-- de saida ou envio ao Full, e o nome do arquivo nao decide. Ate o parse, a
-- coluna fica NULA -- melhor que nascer dizendo "NFE" e mentir enquanto espera.
alter table public.documents alter column document_type drop not null;
alter table public.documents alter column document_type drop default;

alter table public.documents
  add constraint documents_document_type_check check (document_type is null or document_type in (
    -- O XML da NF-e: o caminho preferido, o unico conferido pela SEFAZ.
    'NFE',
    -- O papel da mesma nota, quando so ele chega.
    'DANFE_PDF',
    -- "Pedido de Saida" impresso do UpSeller.
    'SAIDA_UPSELLER_PDF',
    -- "Instrucoes de preparacao" de um envio ao Full (Mercado Livre).
    'ENVIO_FULL_ML_PDF'
  ));

-- O FORMATO do arquivo, esse sim sabido no upload: e ele que a tela mostra
-- enquanto a leitura nao terminou, e o que decide qual leitor o worker usa.
alter table public.documents
  add column source_format text not null default 'XML'
    check (source_format in ('XML', 'PDF'));

comment on column public.documents.document_type is
  'Layout do documento (D-375): NFE (XML, preferido), DANFE_PDF, SAIDA_UPSELLER_PDF, ENVIO_FULL_ML_PDF. NULO ate o parse: o tipo sai do CONTEUDO do arquivo, nunca do nome dele.';

comment on column public.documents.source_format is
  'XML ou PDF -- sabido no upload (D-375). O document_type so depois da leitura.';

-- A referencia humana do documento: armazem, observacao, numero do envio.
alter table public.documents add column reference text;

comment on column public.documents.reference is
  'A linha que explica o documento a quem confere -- "Armazem ESTOQUE LOJA · ENVIO FULL #77375684 CONTA 1". Vai para a tela, nunca para o ledger (D-375).';

-- ------------------------------------------------------------
-- 2. Item sem valor e sem unidade
-- ------------------------------------------------------------
-- Pedido de separacao nao tem preco. Exigir valor obrigaria a inventar zero, e
-- zero em valor se le como "de graca" -- a mesma distincao de D-254.
alter table public.document_items alter column unit drop not null;
alter table public.document_items alter column unit_value drop not null;
alter table public.document_items alter column total_value drop not null;

comment on column public.document_items.unit_value is
  'NULO quando o documento nao traz valor (pedido de saida, envio ao Full). Nunca zero: zero afirmaria preco (D-254/D-375).';

-- ------------------------------------------------------------
-- 3. A saida que nao e nota fiscal
-- ------------------------------------------------------------
-- Combinado com a frente da D-352 antes de mexer no ledger: so um valor novo no
-- CHECK; nenhuma coluna, `location_kind` ou RPC de saldo muda.
alter table public.stock_movements drop constraint stock_movements_movement_type_check;

alter table public.stock_movements add constraint stock_movements_movement_type_check check (movement_type in (
  'ENTRADA_NFE', 'SAIDA_NFE', 'VENDA_ML', 'CANCELAMENTO_ML', 'DEVOLUCAO_ML',
  'AJUSTE_MANUAL', 'AJUSTE_RECONCILIACAO', 'TRANSFERENCIA',
  'RESERVA', 'LIBERACAO_RESERVA', 'ENTRADA_TRANSITO', 'RECEBIMENTO_TRANSITO',
  'ESTORNO_PRE_CAPTURA', 'ESTORNO_REVERSAO_EXCEDENTE',
  -- D-375: saida conferida por documento NAO fiscal (pedido de saida do
  -- UpSeller, envio ao Full). Nao e `SAIDA_NFE` porque nota nenhuma foi
  -- emitida, e o historico precisa dizer a verdade sobre a origem.
  'SAIDA_DOCUMENTO'
));

-- ------------------------------------------------------------
-- 4. A tela numa leitura
-- ------------------------------------------------------------
create function public.get_documents_overview(
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
               'last_error', p.last_error
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

comment on function public.get_documents_overview(uuid, text, text, text, text, integer, integer) is
  '/notas-fiscais numa leitura (D-375): pagina com itens/unidades/valor por documento, total filtrado, contagens por estado, direcao e tipo, e resumo (em conferencia, em leitura, falhas, aplicados e entradas/saidas de 30 dias, itens sem vinculo). Contagens respeitam a busca e ignoram os recortes (D-250). security invoker: a policy de documents (ADMIN/GESTOR) continua sendo quem autoriza.';

revoke all on function public.get_documents_overview(uuid, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_documents_overview(uuid, text, text, text, text, integer, integer) to authenticated, service_role;
