-- ============================================================
-- Busca Universal: o anuncio SUBSTITUIDO por uma republicacao deixa de ser
-- destino (D-360).
--
-- Em 2026-09-16 o dono republicou MLB6512915288, que virou MLB5244566133, e
-- pediu para apagar o antigo: "como ele foi trocado, nao faz sentido
-- conseguirmos acha-lo quando pesquisarmos". Apagar nao faz sentido -- no
-- Mercado Livre e irreversivel e a doc nao diz o que acontece com o filho, que
-- aponta para o pai; no banco, o antigo sustenta as vendas, o historico da
-- republicacao e a medicao 7/15/30 (D-164). O que o pedido quer e outra coisa:
-- nao cair no anuncio velho ao buscar.
--
-- Entao, no ramo `anuncio`:
--   * o PAI de uma republicacao concluida (`child_item_id` preenchido) sai do
--     resultado;
--   * quem digita o MLB antigo chega ao FILHO, porque o numero que a pessoa
--     tem na mao (de um pedido antigo, de uma conversa) continua valendo.
-- Operacao sem filho -- reprovada, em andamento, com falha -- nao esconde
-- nada: o anuncio ainda e o anuncio.
--
-- O resto da funcao e a de 20260902201330, sem mudanca. Assinatura inalterada
-- -- mesmas 4 colunas, mesmos 2 argumentos: nada a regenerar em types.ts.
-- security invoker continua: a RLS de `listing_relists` (acesso a conta)
-- decide o que a subconsulta enxerga, como ja decide para `listings`.
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
    -- D-360: o pai substituido por republicacao sai, e o MLB dele leva ao filho.
    select 'anuncio', l.title, l.item_id, '/anuncios/' || l.item_id
    from public.listings l, q
    where l.organization_id = p_organization_id
      and q.term <> ''
      and (
        l.title ilike '%' || q.term || '%'
        or l.item_id ilike '%' || q.term || '%'
        or exists (
          select 1
          from public.listing_relists r
          where r.organization_id = l.organization_id
            and r.ml_account_id = l.ml_account_id
            and r.child_item_id = l.item_id
            and r.parent_item_id ilike '%' || q.term || '%'
        )
      )
      and not exists (
        select 1
        from public.listing_relists r
        where r.organization_id = l.organization_id
          and r.ml_account_id = l.ml_account_id
          and r.parent_item_id = l.item_id
          and r.child_item_id is not null
      )
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
  'Busca universal / Command Palette (docs/PRODUCT_REQUIREMENTS.md, "Busca universal") — UNION ALL de SETE entidades, e a regra de D-060 continua: so entra o que tem destino de navegacao REAL. sku (/skus/{id}), anuncio (/anuncios/{item_id}, individual desde D-168; desde D-360 o pai substituido por republicacao sai e o MLB dele leva ao filho), conta (/contas, ainda sem pagina propria), fornecedor (/fornecedores/{id}, individual desde D-174), pedido de compra (/compras/{id}), atendimento (/atendimento/{id}, D-095) e NF-e (/notas-fiscais/{id}). FORA: acao da Central de Acoes, porque `/acoes` nao tem rota por id nem le searchParams -- e a clausula do item e "quando aplicavel"; importacao, porque nao ha identificador que alguem digite; pedido de VENDA, porque continua sem pagina de detalhe. security invoker de proposito: a RLS de cada tabela decide o escopo (support_cases por acesso a conta, documents so para ADMIN/GESTOR, listing_relists por acesso a conta).';

revoke all on function public.search_entities(uuid, text) from public, anon, authenticated;
grant execute on function public.search_entities(uuid, text) to authenticated, service_role;
