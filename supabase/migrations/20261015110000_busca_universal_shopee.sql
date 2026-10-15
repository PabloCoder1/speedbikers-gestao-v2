-- ============================================================
-- D-467 — C-57: a Busca Universal acha a loja, o anúncio e o pedido da Shopee
--
-- `search_entities` é a busca da paleta e da `/busca`. Esta migration a
-- estende, sem criar uma segunda busca (combinado com o A2, 15/10):
--
-- 1. As QUATRO colunas de hoje continuam (`entity_type`, `label`, `sublabel`,
--    `href`), e TRÊS entram no fim: `marketplace` ('ML' | 'SHOPEE' | NULO,
--    a convenção de `marketplace_accounts`), `entity_id` (o id que a tela usa:
--    sku_id, item_id, order_sn...) e `account_id` (a conta do ML ou a loja da
--    Shopee). O `href` segue montado aqui.
-- 2. Três entidades novas, todas com destino REAL (D-060):
--    - `loja`: a loja Shopee, com a de teste marcada ("Shopee · teste");
--      destino `/contas`, como a conta do ML.
--    - `anuncio_shopee`: nome, SKU do item ou da variação por trecho e o
--      item_id exato, só de loja live e sem item apagado; destino
--      `/anuncios/shopee?loja=<loja>&q=<item_id>`, que a lista acha pelo
--      item_id (`get_shopee_listings`).
--    - `pedido_shopee`: o `order_sn` por PREFIXO, só de loja live; destino
--      `/vendas/shopee?loja=<loja>&from=<dia>&to=<dia>&pedido=<order_sn>` --
--      o dia de São Paulo do pedido, porque a lista filtra por período, e o
--      `pedido`, que a tela repassa ao `p_order_sn` novo de `get_shopee_orders`.
-- 3. O pedido do ML continua FORA: não há página nem lista que o filtre pelo
--    número (D-060). Entra quando houver destino.
-- 4. Permissão: invoker, a RLS de cada tabela decide (por conta, D-102; por
--    loja, D-433). Quem não alcança a loja não vê o anúncio nem o pedido dela.
-- 5. O pedido pelo prefixo vai pelo índice novo `(organization_id, order_sn
--    text_pattern_ops)` -- a chave de `shopee_orders` começa pela loja. O
--    termo só procura pedido quando é letra, dígito ou hífen (2 a 40): nada de
--    `%`/`_` virando curinga.
-- 6. `language plpgsql` + `force_custom_plan` (D-305): o plano sai com o
--    termo, e é isso que deixa o LIKE de prefixo usar o índice.
-- ============================================================

create index if not exists shopee_orders_org_order_sn_idx
  on public.shopee_orders (organization_id, order_sn text_pattern_ops);

comment on index public.shopee_orders_org_order_sn_idx is
  'A Busca Universal acha o pedido Shopee pelo prefixo do order_sn sem varrer a tabela (D-467).';

-- O retorno muda (colunas novas no fim): drop + create. O grant volta abaixo.
drop function if exists public.search_entities(uuid, text);

create function public.search_entities(
  p_organization_id uuid,
  p_query text
)
returns table (
  entity_type text,
  label text,
  sublabel text,
  href text,
  marketplace text,
  entity_id text,
  account_id uuid
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
#variable_conflict use_column
declare
  v_term text := btrim(coalesce(p_query, ''));
  -- O pedido só é procurado com termo que pode ser um order_sn: nada de `%`
  -- ou `_` virando curinga no LIKE de prefixo.
  v_pedido boolean := btrim(coalesce(p_query, '')) ~ '^[A-Za-z0-9-]{2,40}$';
begin
  if v_term = '' then
    return;
  end if;

  return query
  (
    select 'sku' as entity_type, sk.sku as label, coalesce(sk.title, '') as sublabel, '/skus/' || sk.id::text as href,
           null::text as marketplace, sk.id::text as entity_id, null::uuid as account_id
    from public.skus sk
    where sk.organization_id = p_organization_id
      and (sk.sku ilike '%' || v_term || '%' or sk.title ilike '%' || v_term || '%')
    order by sk.sku
    limit 5
  )
  union all
  (
    -- Destino individual desde D-168: o item_id E o parametro da rota.
    -- D-360: o pai substituido por republicacao sai, e o MLB dele leva ao filho.
    select 'anuncio', l.title, l.item_id, '/anuncios/' || l.item_id,
           'ML', l.item_id, l.ml_account_id
    from public.listings l
    where l.organization_id = p_organization_id
      and (
        l.title ilike '%' || v_term || '%'
        or l.item_id ilike '%' || v_term || '%'
        or exists (
          select 1
          from public.listing_relists r
          where r.organization_id = l.organization_id
            and r.ml_account_id = l.ml_account_id
            and r.child_item_id = l.item_id
            and r.parent_item_id ilike '%' || v_term || '%'
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
    -- D-467: o anuncio da Shopee, so de loja live e sem item apagado (a mesma
    -- regra da lista). O destino e a lista filtrada pela loja e pelo item_id,
    -- que `get_shopee_listings` casa exato.
    select 'anuncio_shopee', i.item_name, i.item_id::text || ' · ' || coalesce(nullif(btrim(sh.shop_name), ''), 'Loja ' || sh.shop_id::text),
           '/anuncios/shopee?loja=' || sh.id::text || '&q=' || i.item_id::text,
           'SHOPEE', i.item_id::text, sh.id
    from public.shopee_items i
    join public.shopee_shops sh on sh.id = i.shopee_shop_id
    where i.organization_id = p_organization_id
      and sh.environment = 'live'
      and i.item_status <> all (array['SELLER_DELETE', 'SHOPEE_DELETE'])
      and (
        i.item_name ilike '%' || v_term || '%'
        or i.item_sku ilike '%' || v_term || '%'
        or i.item_id::text = v_term
        or exists (
          select 1
          from public.shopee_item_models m
          where m.shopee_shop_id = i.shopee_shop_id
            and m.item_id = i.item_id
            and m.model_sku ilike '%' || v_term || '%'
        )
      )
    order by i.item_name
    limit 5
  )
  union all
  (
    -- Conta segue na lista: nao existe pagina por conta ate hoje.
    select 'conta', ma.label, ma.slug, '/contas',
           'ML', ma.id::text, ma.id
    from public.ml_accounts ma
    where ma.organization_id = p_organization_id
      and (ma.label ilike '%' || v_term || '%' or ma.slug ilike '%' || v_term || '%')
    order by ma.label
    limit 5
  )
  union all
  (
    -- D-467: a loja da Shopee, como a conta do ML (destino /contas). A de
    -- teste aparece, marcada: e a unica que existe antes do Go Live.
    select 'loja', coalesce(nullif(btrim(sh.shop_name), ''), 'Loja ' || sh.shop_id::text),
           case when sh.environment = 'live' then 'Shopee' else 'Shopee · teste' end,
           '/contas',
           'SHOPEE', sh.id::text, sh.id
    from public.shopee_shops sh
    where sh.organization_id = p_organization_id
      and (sh.shop_name ilike '%' || v_term || '%' or sh.shop_id::text = v_term)
    order by 2
    limit 5
  )
  union all
  (
    -- Destino individual desde D-174.
    select 'fornecedor', s.name, coalesce(s.document, ''), '/fornecedores/' || s.id::text,
           null::text, s.id::text, null::uuid
    from public.suppliers s
    where s.organization_id = p_organization_id
      and (s.name ilike '%' || v_term || '%' or s.document ilike '%' || v_term || '%')
    order by s.name
    limit 5
  )
  union all
  (
    select 'pedido_compra', 'Pedido #' || po.order_number::text, po.status, '/compras/' || po.id::text,
           null::text, po.id::text, null::uuid
    from public.purchase_orders po
    where po.organization_id = p_organization_id
      and po.order_number::text ilike '%' || v_term || '%'
    order by po.order_number
    limit 5
  )
  union all
  (
    -- D-467: o pedido da Shopee pelo PREFIXO do order_sn, so de loja live. O
    -- destino leva o dia de Sao Paulo do pedido (a lista filtra por periodo)
    -- e o `pedido`, que a tela repassa ao `p_order_sn` de get_shopee_orders.
    select 'pedido_shopee', 'Pedido ' || o.order_sn,
           coalesce(nullif(btrim(sh.shop_name), ''), 'Loja ' || sh.shop_id::text)
             || ' · ' || to_char((o.shopee_created_at at time zone 'America/Sao_Paulo')::date, 'DD/MM/YYYY'),
           '/vendas/shopee?loja=' || sh.id::text
             || '&from=' || ((o.shopee_created_at at time zone 'America/Sao_Paulo')::date)::text
             || '&to=' || ((o.shopee_created_at at time zone 'America/Sao_Paulo')::date)::text
             || '&pedido=' || o.order_sn,
           'SHOPEE', o.order_sn, sh.id
    from public.shopee_orders o
    join public.shopee_shops sh on sh.id = o.shopee_shop_id
    where v_pedido
      and o.organization_id = p_organization_id
      and sh.environment = 'live'
      and (o.order_sn like v_term || '%' or o.order_sn like upper(v_term) || '%')
    order by o.shopee_created_at desc, o.order_sn
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
           '/atendimento/' || sc.id::text,
           'ML', sc.id::text, sc.ml_account_id
    from public.support_cases sc
    where sc.organization_id = p_organization_id
      and (sc.external_case_id ilike '%' || v_term || '%'
        or sc.pack_id::text ilike '%' || v_term || '%')
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
           '/notas-fiscais/' || d.id::text,
           null::text, d.id::text, null::uuid
    from public.documents d
    where d.organization_id = p_organization_id
      and (d.document_number ilike '%' || v_term || '%'
        or d.access_key ilike '%' || v_term || '%'
        or d.issuer_name ilike '%' || v_term || '%')
    order by d.document_number
    limit 5
  );
end;
$fn$;

comment on function public.search_entities(uuid, text) is
  'Busca universal / Command Palette (docs/PRODUCT_REQUIREMENTS.md, "Busca universal") — UNION ALL de DEZ entidades, e a regra de D-060 continua: so entra o que tem destino de navegacao REAL. sku (/skus/{id}), anuncio do ML (/anuncios/{item_id}, D-168; D-360 republicacao), anuncio_shopee (/anuncios/shopee?loja=&q=item_id, so loja live, D-467), conta do ML (/contas), loja da Shopee (/contas, a de teste marcada, D-467), fornecedor (/fornecedores/{id}, D-174), pedido de compra (/compras/{id}), pedido_shopee (/vendas/shopee?loja=&from=&to=&pedido=, prefixo do order_sn, so loja live, D-467), atendimento (/atendimento/{id}, D-095) e NF-e (/notas-fiscais/{id}). Colunas no fim (D-467): marketplace (ML | SHOPEE | nulo), entity_id e account_id. FORA: acao da Central de Acoes (sem rota por id), importacao (sem identificador que alguem digite) e pedido de VENDA do ML (sem pagina nem lista que filtre pelo numero). security invoker de proposito: a RLS de cada tabela decide o escopo (por conta, D-102; por loja Shopee, D-433; documents so ADMIN/GESTOR).';

revoke all on function public.search_entities(uuid, text) from public, anon;
grant execute on function public.search_entities(uuid, text) to authenticated, service_role;

-- get_shopee_orders: o filtro pelo pedido, que o destino da busca usa.
drop function if exists public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer);

create function public.get_shopee_orders(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_shopee_shop_id uuid default null,
  p_situacao text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  -- D-467: o pedido que a Busca Universal abriu (o order_sn exato, sem
  -- diferenciar maiuscula). NULO = a lista de sempre.
  p_order_sn text default null
)
returns table (
  shopee_shop_id uuid,
  shop_name text,
  environment text,
  order_sn text,
  order_status text,
  situacao text,
  shopee_created_at timestamptz,
  unidades bigint,
  receita_bruta numeric,
  recebido numeric,
  financeiro_lido boolean,
  com_devolucao boolean,
  itens jsonb,
  total_count bigint
)
language sql
stable
set search_path = ''
as $fn$
  select
    v.shopee_shop_id, v.shop_name, v.environment, v.order_sn, v.order_status, v.situacao, v.shopee_created_at,
    v.unidades, v.receita_bruta, v.recebido, v.financeiro_lido, v.com_devolucao, v.resumo,
    count(*) over ()
  from public.shopee_sales_orders v
  where v.organization_id = p_organization_id
    and v.dia between p_date_from and p_date_to
    and (p_shopee_shop_id is null or v.shopee_shop_id = p_shopee_shop_id)
    and (p_situacao is null or v.situacao = p_situacao)
    and (nullif(btrim(p_order_sn), '') is null or upper(v.order_sn) = upper(btrim(p_order_sn)))
  order by v.shopee_created_at desc, v.order_sn
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$fn$;

comment on function public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer, text) is
  'Pedidos Shopee no periodo (D-430), mais novos primeiro, com situacao, receita bruta, recebido, financeiro lido, devolucao e os itens com o SKU gravado; filtro por loja, situacao e pelo pedido (p_order_sn, o destino da Busca Universal, D-467); paginada (ate 200) com total_count.';

revoke all on function public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer, text) from public, anon;
grant execute on function public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer, text) to authenticated;
