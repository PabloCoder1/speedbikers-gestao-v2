-- ============================================================
-- Busca Universal: as entidades que GANHARAM destino desde D-060.
--
-- Item aberto do Checkpoint P1 — "adicionar as entidades novas que ja possuem
-- destino real a Busca Universal, incluindo Central de Acoes quando
-- aplicavel". A regra de D-060 continua sendo a regra: **so entra entidade
-- com destino de navegacao REAL**, porque resultado que nao leva a lugar
-- nenhum e ruido com aparencia de recurso.
--
-- O que mudou desde D-060 foi o mundo, nao a regra. Medido contra as rotas
-- que existem hoje em apps/web/app:
--
--   | entidade      | em D-060                  | hoje                        |
--   |---------------|---------------------------|-----------------------------|
--   | anuncio       | /anuncios (lista)         | **/anuncios/{item_id}** D-168|
--   | fornecedor    | /fornecedores (lista)     | **/fornecedores/{id}** D-174 |
--   | atendimento   | nao existia               | **/atendimento/{id}** D-095  |
--   | nota fiscal   | nao entrou na fatia       | **/notas-fiscais/{id}**      |
--
-- As duas primeiras nao sao entidade nova: sao destino que MELHOROU e ficou
-- para tras. O comentario da propria funcao dizia "anuncio -> /anuncios, sem
-- pagina por item ainda", e isso deixou de ser verdade em D-168 sem que
-- ninguem voltasse aqui. Buscar um anuncio e cair na lista inteira e
-- exatamente o trabalho manual que a Busca Universal existe para poupar.
--
-- CENTRAL DE ACOES FICA DE FORA, e agora com medicao em vez de "ainda nao
-- existe": `/acoes` existe desde D-064, mas **nao ha rota `/acoes/[id]`** —
-- a pagina nao le `searchParams` nenhum, entao nao existe deep link para uma
-- acao individual. A clausula do item e "quando aplicavel", e nao e. Entra no
-- dia em que houver destino, pela mesma regra que barrou as outras.
--
-- IMPORTACOES tambem fica de fora, e por outro motivo: `/importacoes/{id}`
-- existe, mas uma importacao nao tem identificador que alguem digite numa
-- busca — e um upload, achado por data na propria tela. Destino existir nao
-- basta; precisa haver o que procurar.
--
-- RLS DECIDE O ESCOPO, como ja decidia: a funcao e `security invoker`, entao
-- `support_cases` filtra por acesso a conta e `documents` so aparece para
-- ADMIN/GESTOR. Nao ha filtro de papel escrito aqui, e nao deve haver.
--
-- Assinatura inalterada — mesmas 4 colunas, mesmos 2 argumentos: nada a
-- regenerar em `packages/db/src/types.ts`.
-- ============================================================

create or replace function public.search_entities(
  p_organization_id uuid,
  p_query text
)
returns table (
  entity_type text,
  label text,
  sublabel text,
  href text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select trim(p_query) as term
  )
  (
    select 'sku' as entity_type, sk.sku as label, coalesce(sk.title, '') as sublabel, '/skus/' || sk.id::text as href
    from public.skus sk, q
    where sk.organization_id = p_organization_id
      and q.term <> ''
      and (sk.sku ilike '%' || q.term || '%' or sk.title ilike '%' || q.term || '%')
    order by sk.sku
    limit 5
  )
  union all
  (
    -- Destino individual desde D-168: o item_id E o parametro da rota.
    select 'anuncio', l.title, l.item_id, '/anuncios/' || l.item_id
    from public.listings l, q
    where l.organization_id = p_organization_id
      and q.term <> ''
      and (l.title ilike '%' || q.term || '%' or l.item_id ilike '%' || q.term || '%')
    order by l.title
    limit 5
  )
  union all
  (
    -- Conta segue na lista: nao existe pagina por conta ate hoje.
    select 'conta', ma.label, ma.slug, '/contas'
    from public.ml_accounts ma, q
    where ma.organization_id = p_organization_id
      and q.term <> ''
      and (ma.label ilike '%' || q.term || '%' or ma.slug ilike '%' || q.term || '%')
    order by ma.label
    limit 5
  )
  union all
  (
    -- Destino individual desde D-174.
    select 'fornecedor', s.name, coalesce(s.document, ''), '/fornecedores/' || s.id::text
    from public.suppliers s, q
    where s.organization_id = p_organization_id
      and q.term <> ''
      and (s.name ilike '%' || q.term || '%' or s.document ilike '%' || q.term || '%')
    order by s.name
    limit 5
  )
  union all
  (
    select 'pedido_compra', 'Pedido #' || po.order_number::text, po.status, '/compras/' || po.id::text
    from public.purchase_orders po, q
    where po.organization_id = p_organization_id
      and q.term <> ''
      and po.order_number::text ilike '%' || q.term || '%'
    order by po.order_number
    limit 5
  )
  union all
  (
    -- Atendimento (D-095). Procura-se pelo id remoto do caso ou pelo pack,
    -- que sao os numeros que a pessoa tem na mao ao vir do Mercado Livre.
    -- `external_type` cai para `channel` quando o tipo nao veio.
    select 'atendimento',
           'Atendimento ' || coalesce(sc.external_case_id, sc.external_case_key),
           coalesce(sc.external_type, sc.channel),
           '/atendimento/' || sc.id::text
    from public.support_cases sc, q
    where sc.organization_id = p_organization_id
      and q.term <> ''
      and (sc.external_case_id ilike '%' || q.term || '%'
        or sc.pack_id::text ilike '%' || q.term || '%')
    order by sc.external_case_id
    limit 5
  )
  union all
  (
    -- NF-e: numero, chave de acesso ou emitente -- os tres jeitos de alguem
    -- chegar com a nota na mao. So ADMIN/GESTOR enxerga, e quem decide isso e
    -- a RLS de `documents`, nao um filtro escrito aqui.
    select 'nota_fiscal',
           -- document_number e ANULAVEL, e a busca alcanca a nota pelo
           -- emitente: sem o coalesce, o rotulo viria NULO e a linha apareceria
           -- vazia na paleta.
           'NF-e ' || coalesce(d.document_number, '(sem número)'),
           coalesce(d.issuer_name, ''),
           '/notas-fiscais/' || d.id::text
    from public.documents d, q
    where d.organization_id = p_organization_id
      and q.term <> ''
      and (d.document_number ilike '%' || q.term || '%'
        or d.access_key ilike '%' || q.term || '%'
        or d.issuer_name ilike '%' || q.term || '%')
    order by d.document_number
    limit 5
  )
$$;

comment on function public.search_entities(uuid, text) is
  'Busca universal / Command Palette (docs/PRODUCT_REQUIREMENTS.md, "Busca universal") — UNION ALL de SETE entidades, e a regra de D-060 continua: so entra o que tem destino de navegacao REAL. sku (/skus/{id}), anuncio (/anuncios/{item_id}, individual desde D-168), conta (/contas, ainda sem pagina propria), fornecedor (/fornecedores/{id}, individual desde D-174), pedido de compra (/compras/{id}), atendimento (/atendimento/{id}, D-095) e NF-e (/notas-fiscais/{id}). FORA: acao da Central de Acoes, porque `/acoes` nao tem rota por id nem le searchParams -- e a clausula do item e "quando aplicavel"; importacao, porque nao ha identificador que alguem digite; pedido de VENDA, porque continua sem pagina de detalhe. security invoker de proposito: a RLS de cada tabela decide o escopo (support_cases por acesso a conta, documents so para ADMIN/GESTOR).';

revoke all on function public.search_entities(uuid, text) from public, anon;
grant execute on function public.search_entities(uuid, text) to authenticated, service_role;
