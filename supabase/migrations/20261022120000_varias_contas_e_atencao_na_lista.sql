-- ============================================================
-- C-80 + C-85 (D-637) -- varias contas e "Precisam de atencao" na /anuncios.
--
-- C-80 (pedido do A3): `p_ml_account_ids uuid[]` no fim da lista, da faixa e,
-- pela propria lista, do CSV. Nulo = todas as contas alcancadas, como o
-- `p_ml_account_id` nulo. O array vazio e conta e contas juntas sao recusados.
-- A conta fora da RLS nao aparece. A dispersao (C-77) continua comparando com
-- todas as contas visiveis, e a queda e por anuncio.
--
-- C-85 (aprovado pelo dono em 21/10, com as cinco condicoes, por faturamento e
-- sem pontuacao): o anuncio ativo ou pausado que vende sem estoque, vende sem
-- vinculo, tem acao aberta POR ANUNCIO, esta em queda (C-79) ou com o preco
-- divergente (C-77).
-- - Lista: `p_atencao` ('all' | 'atencao') e `atencao_motivos text[]` em toda
--   linha, na ordem sem_estoque_vendendo, sem_vinculo_vendendo, acao_aberta,
--   queda, preco_divergente. NULO sem as cinco reguas (sem o teto ou sem a
--   queda do periodo); `{}` fora de ativo/pausado ou sem motivo. O filtro sem
--   as reguas e recusado.
-- - Faixa: `p_date_from`/`p_date_to` e `precisam_atencao`, com o N da queda
--   pela MESMA regra das datas da lista; NULA sem as reguas.
-- A ordem da lista nao muda (faturamento).
--
-- Os corpos sao as definicoes atuais (pg_get_functiondef do banco com todas as
-- migrations), com os parametros novos no fim. As assinaturas antigas saem:
-- a chamada de hoje, sem os params novos, resolve nestas com o mesmo resultado.
-- ============================================================

drop function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text, text, text, numeric, text);

CREATE OR REPLACE FUNCTION public.get_listings_dashboard(p_organization_id uuid, p_date_from date, p_date_to date, p_ml_account_id uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_link_state text DEFAULT 'all'::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_stock text DEFAULT 'all'::text, p_full text DEFAULT 'all'::text, p_sold text DEFAULT 'all'::text, p_order text DEFAULT 'revenue_desc'::text, p_promo text DEFAULT 'all'::text, p_preco text DEFAULT 'all'::text, p_preco_teto numeric DEFAULT NULL::numeric, p_queda text DEFAULT 'all'::text, p_atencao text DEFAULT 'all'::text, p_ml_account_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(listing_id uuid, item_id text, title text, status text, price numeric, available_quantity integer, synced_at timestamp with time zone, ml_account_id uuid, account_label text, sku_id uuid, sku text, link_state text, units_sold bigint, gross_revenue numeric, visits numeric, days_observed integer, conversion_rate numeric, full_quantity numeric, thumbnail_url text, permalink text, in_promotion boolean, promotional_price numeric, promotion_checked_at timestamp with time zone, total_count bigint, recorte_faturamento numeric, recorte_unidades bigint, recorte_visitas numeric, recorte_pedidos_observados numeric, preco_efetivo numeric, sku_preco_min numeric, sku_preco_max numeric, sku_anuncios_com_preco integer, sku_dispersao_pct numeric, sku_dispersao_sku_id uuid, queda_estado text, queda_z numeric, queda_calculada_em timestamp with time zone, atencao_motivos text[])
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  -- C-79: a queda se le pelo numero de dias do periodo, so quando ele termina
  -- hoje (a /anuncios usa os ultimos N dias); o calculo e dos N fechados ate ontem.
  v_queda_dias integer := case
    when p_date_to = (now() at time zone 'America/Sao_Paulo')::date then p_date_to - p_date_from + 1
  end;
  -- C-85: as cinco reguas so existem com o teto (C-77) e com a queda do
  -- periodo (C-79: N de 7, 15, 30, 60 ou 90 dias terminando hoje). Sem uma
  -- delas, "nenhum motivo" seria falso: os motivos ficam NULOS.
  v_atencao boolean := p_preco_teto is not null and p_preco_teto >= 0
    and coalesce(v_queda_dias in (7, 15, 30, 60, 90), false);
begin
  -- C-77: o teto vem da web (TETO_DISPERSAO_PCT), num lugar so; sem ele o
  -- filtro nao tem regua, e e recusado em vez de cair num numero inventado.
  if p_preco = 'divergente' and (p_preco_teto is null or p_preco_teto < 0) then
    raise exception 'p_preco divergente exige p_preco_teto >= 0';
  end if;

  -- C-80: varias contas. Vazio nao e "todas" (seria um defeito da tela), e
  -- conta e contas juntas tambem: a tela manda um ou outro.
  if p_ml_account_ids is not null and cardinality(p_ml_account_ids) = 0 then
    raise exception 'p_ml_account_ids vazio: sem conta escolhida, nao mande o parametro';
  end if;

  if p_ml_account_ids is not null and p_ml_account_id is not null then
    raise exception 'p_ml_account_id e p_ml_account_ids juntos: mande um ou outro';
  end if;

  -- C-85: o filtro pede as cinco reguas; sem elas e recusado.
  if p_atencao = 'atencao' and not v_atencao then
    raise exception 'p_atencao exige p_preco_teto >= 0 e o periodo de 7, 15, 30, 60 ou 90 dias terminando hoje';
  end if;

  return query
  with metricas_dia as (
    select m.ml_account_id, m.mlb_id, m.metric_date,
           sum(m.units_sold)    as units_sold,
           sum(m.gross_revenue) as gross_revenue,
           sum(m.orders_count)  as orders_count
    from public.daily_listing_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
    group by m.ml_account_id, m.mlb_id, m.metric_date
  ),
  metricas as (
    select d.ml_account_id, d.mlb_id,
           sum(d.units_sold)::bigint as units_sold,
           sum(d.gross_revenue)      as gross_revenue
    from metricas_dia d
    group by d.ml_account_id, d.mlb_id
  ),
  visitas as (
    select v.ml_account_id, v.item_id,
           sum(v.visits) as visits,
           count(*)::integer as days_observed,
           sum(coalesce(md.orders_count, 0)) as orders_observed
    from public.daily_listing_visits v
    left join metricas_dia md
      on md.ml_account_id = v.ml_account_id
     and md.mlb_id = v.item_id
     and md.metric_date = v.metric_date
    where v.organization_id = p_organization_id
      and v.metric_date between p_date_from and p_date_to
    group by v.ml_account_id, v.item_id
  ),
  vinculos as (
    select distinct k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
  ),
  -- C-85: a acao aberta POR ANUNCIO. A de SKU (sem `mlb_id`) e a da Shopee nao
  -- contam. Uma passada pelas abertas da organizacao (actions_org_status_idx).
  acoes_abertas as (
    select distinct ac.ml_account_id, ac.mlb_id
    from public.actions ac
    where v_atencao
      and ac.organization_id = p_organization_id
      and ac.status in ('novo', 'em_andamento')
      and ac.ml_account_id is not null
      and ac.mlb_id is not null
  ),
  full_ultimo as (
    -- A DEFINICAO CANONICA de Full (D-173/D-204), a mesma de `get_sku_dashboard`
    -- e `get_fulfillment_overview`: o ultimo snapshot por (conta, inventory_id)
    -- -- o bucket que o Mercado Livre reparte --, e so dos ultimos 3 dias.
    select distinct on (f.ml_account_id, f.inventory_id)
           f.ml_account_id, f.item_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_por_anuncio as (
    select u.ml_account_id, u.item_id, sum(u.quantity) as full_quantity
    from full_ultimo u
    group by u.ml_account_id, u.item_id
  ),
  -- C-77 (D-625): o conjunto de anuncios de um SKU e o de get_sku_listings
  -- (D-122): listings.sku_id uniao o vinculo ITEM, inclusive o por variacao
  -- (o preco e o do ITEM). So ATIVO ou PAUSADO -- o encerrado fica fora, a
  -- decisao do A2/A3 de 21/10, a mesma do diagnostico do SKU (D-630).
  anuncio_sku as (
    select l.sku_id, l.ml_account_id, l.item_id
    from public.listings l
    where l.organization_id = p_organization_id
      and l.sku_id is not null
    union
    select k.sku_id, k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
      and k.ref_kind = 'ITEM'
      and k.item_id is not null
  ),
  -- O preco que chega ao comprador: o promocional, senao o cadastrado
  -- (D-389), o mesmo `precoEfetivo` do diagnostico do SKU.
  preco_sku as (
    select x.sku_id,
           min(coalesce(pl.promotional_price, pl.price)) as preco_minimo,
           max(coalesce(pl.promotional_price, pl.price)) as preco_maximo,
           count(*)::integer as anuncios_com_preco
    from anuncio_sku x
    join public.listings pl
      on pl.organization_id = p_organization_id
     and pl.ml_account_id = x.ml_account_id
     and pl.item_id = x.item_id
    where pl.status in ('active', 'paused')
      and coalesce(pl.promotional_price, pl.price) is not null
    group by x.sku_id
  ),
  -- A dispersao CHEIA: (maior - menor) / menor x 100, so com dois precos ou
  -- mais. Menor zero da 0, como no diagnostico. O arredondamento e so da
  -- exibicao; o filtro e a ordem comparam o valor cheio (D-630).
  dispersao_sku as (
    select p.sku_id, p.preco_minimo, p.preco_maximo, p.anuncios_com_preco,
           case when p.preco_minimo = 0 then 0::numeric
                else (p.preco_maximo - p.preco_minimo) / p.preco_minimo * 100 end as dispersao_cheia
    from preco_sku p
    where p.anuncios_com_preco >= 2
  ),
  -- O anuncio vinculado por variacao pode ter varios SKUs: a linha leva o
  -- de MAIOR dispersao, e diz qual.
  dispersao_anuncio as (
    select distinct on (x.ml_account_id, x.item_id)
           x.ml_account_id, x.item_id, d.sku_id, d.preco_minimo, d.preco_maximo,
           d.anuncios_com_preco, d.dispersao_cheia
    from anuncio_sku x
    join dispersao_sku d on d.sku_id = x.sku_id
    order by x.ml_account_id, x.item_id, d.dispersao_cheia desc, d.sku_id
  ),
  base as (
    select
      l.id as listing_id, l.item_id, l.title, l.status, l.price,
      l.available_quantity, l.synced_at, l.ml_account_id,
      a.label as account_label, l.sku_id, s.sku,
      case when l.sku_id is not null   then 'linked'
           when kv.item_id is not null then 'linked_variation'
           else 'unlinked' end as link_state,
      coalesce(md.units_sold, 0)::bigint as units_sold,
      coalesce(md.gross_revenue, 0) as gross_revenue,
      vs.visits,
      coalesce(vs.days_observed, 0) as days_observed,
      round(vs.orders_observed::numeric / nullif(vs.visits, 0), 4) as conversion_rate,
      vs.orders_observed,
      -- NULA sem snapshot: ausencia de dado nao e zero (D-067).
      fa.full_quantity,
      l.thumbnail_url,
      l.permalink,
      l.in_promotion,
      l.promotional_price,
      l.promotion_checked_at,
      coalesce(l.promotional_price, l.price) as preco_ao_comprador,
      da.preco_minimo,
      da.preco_maximo,
      da.anuncios_com_preco,
      da.dispersao_cheia,
      da.sku_id as dispersao_sku_id,
      qd.estado as estado_da_queda,
      qd.z as z_da_queda,
      qd.calculado_em as calculo_da_queda,
      -- C-85: os motivos de "precisa de atencao", na ordem da tela. NULO sem as
      -- cinco reguas; `{}` fora de ativo/pausado (nao e candidato) ou quando
      -- nenhuma vale.
      case
        when not v_atencao then null
        when l.status not in ('active', 'paused') then '{}'::text[]
        else array_remove(array[
          case when l.available_quantity = 0 and coalesce(md.units_sold, 0) > 0 then 'sem_estoque_vendendo' end,
          case when l.sku_id is null and kv.item_id is null and coalesce(md.units_sold, 0) > 0 then 'sem_vinculo_vendendo' end,
          case when aa.mlb_id is not null then 'acao_aberta' end,
          case when qd.estado = 'queda' then 'queda' end,
          case when da.dispersao_cheia > p_preco_teto then 'preco_divergente' end
        ], null)
      end as motivos_de_atencao
    from public.listings l
    join public.ml_accounts a on a.id = l.ml_account_id
    left join public.skus s on s.id = l.sku_id
    left join metricas md on md.ml_account_id = l.ml_account_id and md.mlb_id = l.item_id
    left join visitas  vs on vs.ml_account_id = l.ml_account_id and vs.item_id = l.item_id
    left join vinculos kv on kv.ml_account_id = l.ml_account_id and kv.item_id = l.item_id
    left join full_por_anuncio fa on fa.ml_account_id = l.ml_account_id and fa.item_id = l.item_id
    left join dispersao_anuncio da on da.ml_account_id = l.ml_account_id and da.item_id = l.item_id
    left join public.listing_sales_drop qd
      on qd.ml_account_id = l.ml_account_id
     and qd.item_id = l.item_id
     and qd.periodo_dias = v_queda_dias
    left join acoes_abertas aa on aa.ml_account_id = l.ml_account_id and aa.mlb_id = l.item_id
    where l.organization_id = p_organization_id
      -- D-631: o anuncio excluido no Mercado Livre sai da tela.
      and l.deleted_at is null
      and (p_ml_account_id is null or l.ml_account_id = p_ml_account_id)
      -- C-80: as contas escolhidas; a fora da RLS simplesmente nao aparece. A
      -- dispersao (C-77) continua comparando com as contas que ficam de fora.
      and (p_ml_account_ids is null or l.ml_account_id = any(p_ml_account_ids))
      and (p_status is null or l.status = p_status)
      and case p_stock
            when 'out' then l.available_quantity = 0
            when 'in'  then l.available_quantity > 0
            else true
          end
      and case p_full
            when 'with'    then coalesce(fa.full_quantity, 0) > 0
            when 'without' then coalesce(fa.full_quantity, 0) = 0
            else true
          end
      /*
        VENDA na janela. `md.units_sold` vem de `metricas`, agregada entre
        `p_date_from` e `p_date_to` -- entao "vendido" quer dizer "vendeu no
        periodo pedido", nunca "ja vendeu algum dia". Sem metrica a linha nao
        existe em `md`, e o `coalesce` a trata como zero: aqui isso e correto,
        porque ausencia de metrica de venda E ausencia de venda (diferente do
        Full, onde ausencia de snapshot nao e estoque zero -- D-067).
      */
      and case p_sold
            when 'with'    then coalesce(md.units_sold, 0) > 0
            when 'without' then coalesce(md.units_sold, 0) = 0
            else true
          end
      /*
        PROMOCAO (D-419). So o anuncio ATIVO roda campanha, e so ele e lido.
        'without' e "lido, e fora de campanha" -- `in_promotion is false`,
        nunca `is not true`: o NAO LIDO (nulo) nao e oferecido como candidato
        a promocao. Valor fora da lista cai em 'all', como os outros eixos.
      */
      and case p_promo
            when 'with'    then l.status = 'active' and l.in_promotion is true
            when 'without' then l.status = 'active' and l.in_promotion is false
            else true
          end
      /*
        DISPERSAO DE PRECO (C-77, D-625): o SKU desta linha chega ao comprador
        com precos que se afastam MAIS que o teto, pela dispersao cheia e com
        `>` estrito (D-630). Sem dispersao (sem SKU, um preco so) a linha nao e
        divergente. Valor fora da lista cai em 'all', como os outros eixos.
      */
      and case p_preco
            when 'divergente' then da.dispersao_cheia > p_preco_teto
            else true
          end
      -- QUEDA (C-79, D-629): so o estado 'queda' do calculo do dia. O 'sem
      -- historico' nunca entra como queda nem como "sem queda".
      and case p_queda
            when 'queda' then qd.estado = 'queda'
            else true
          end
      and (p_search is null
           or l.item_id ilike '%' || p_search || '%'
           or l.title   ilike '%' || p_search || '%'
           or s.sku     ilike '%' || p_search || '%')
  ),
  filtrado as (
    select * from base
    -- `base.link_state` QUALIFICADO: em plpgsql, `link_state` sozinho colide
    -- com a coluna de saida homonima de `returns table` (D-305).
    where case p_link_state
            when 'linked'   then base.link_state in ('linked', 'linked_variation')
            when 'unlinked' then base.link_state = 'unlinked'
            else true
          end
      -- C-85: o OU das cinco, ja calculado; so ativo e pausado tem motivo.
      -- Valor fora da lista cai em 'all', como os outros eixos.
      and case p_atencao
            when 'atencao' then cardinality(base.motivos_de_atencao) > 0
            else true
          end
  )
  select f.listing_id, f.item_id, f.title, f.status, f.price, f.available_quantity,
         f.synced_at, f.ml_account_id, f.account_label, f.sku_id, f.sku, f.link_state,
         f.units_sold, f.gross_revenue, f.visits, f.days_observed, f.conversion_rate,
         f.full_quantity, f.thumbnail_url, f.permalink,
         f.in_promotion, f.promotional_price, f.promotion_checked_at,
         count(*) over () as total_count,
         sum(f.gross_revenue) over () as recorte_faturamento,
         sum(f.units_sold) over ()::bigint as recorte_unidades,
         sum(f.visits) over () as recorte_visitas,
         sum(f.orders_observed) over () as recorte_pedidos_observados,
         f.preco_ao_comprador,
         f.preco_minimo,
         f.preco_maximo,
         f.anuncios_com_preco,
         round(f.dispersao_cheia, 1),
         f.dispersao_sku_id,
         f.estado_da_queda,
         round(f.z_da_queda, 2),
         f.calculo_da_queda,
         f.motivos_de_atencao
  from filtrado f
  -- Uma chave por par de linhas: so a do `p_order` pedido e nao nula, as outras
  -- viram NULL e empatam. Valor fora da lista cai em `revenue_desc` (o `else`
  -- da primeira chave). `nulls last` nas duas direcoes: ausencia de dado vai
  -- para o fim, nunca se mistura com o zero (D-067).
  order by
    case when p_order = 'revenue_asc'    then f.gross_revenue end asc  nulls last,
    case when p_order not in ('revenue_asc', 'units_desc', 'units_asc', 'visits_desc', 'visits_asc',
                              'conversion_desc', 'conversion_asc', 'price_desc', 'price_asc',
                              'stock_desc', 'stock_asc', 'full_desc', 'full_asc',
                              'title_asc', 'title_desc', 'synced_desc', 'synced_asc',
                              'dispersao_desc', 'dispersao_asc')
         or p_order is null                then f.gross_revenue end desc nulls last,
    case when p_order = 'units_desc'      then f.units_sold end desc nulls last,
    case when p_order = 'units_asc'       then f.units_sold end asc  nulls last,
    case when p_order = 'visits_desc'     then f.visits end desc nulls last,
    case when p_order = 'visits_asc'      then f.visits end asc  nulls last,
    case when p_order = 'conversion_desc' then f.conversion_rate end desc nulls last,
    case when p_order = 'conversion_asc'  then f.conversion_rate end asc  nulls last,
    case when p_order = 'price_desc'      then f.price end desc nulls last,
    case when p_order = 'price_asc'       then f.price end asc  nulls last,
    case when p_order = 'stock_desc'      then f.available_quantity end desc nulls last,
    case when p_order = 'stock_asc'       then f.available_quantity end asc  nulls last,
    case when p_order = 'full_desc'       then f.full_quantity end desc nulls last,
    case when p_order = 'full_asc'        then f.full_quantity end asc  nulls last,
    case when p_order = 'title_desc'      then f.title end desc nulls last,
    case when p_order = 'synced_desc'     then f.synced_at end desc nulls last,
    case when p_order = 'synced_asc'      then f.synced_at end asc  nulls last,
    -- C-77: pela dispersao CHEIA, a mesma do filtro; sem dispersao, no fim.
    case when p_order = 'dispersao_desc'  then f.dispersao_cheia end desc nulls last,
    case when p_order = 'dispersao_asc'   then f.dispersao_cheia end asc  nulls last,
    -- Desempate estavel: sem ele, duas paginas seguidas podem repetir ou
    -- pular um anuncio de mesmo valor.
    f.title asc, f.item_id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
end;
$function$;

comment on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text, text, text, numeric, text, text, uuid[]) is
  'A lista de /anuncios (e o CSV): C-77 dispersao, C-79 queda, C-80 p_ml_account_ids (vazio ou junto com p_ml_account_id e recusado) e C-85 p_atencao/atencao_motivos (NULO sem o teto e a queda do periodo).';

revoke all on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text, text, text, numeric, text, text, uuid[]) from public, anon;
grant execute on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text, text, text, numeric, text, text, uuid[]) to authenticated, service_role;

drop function public.get_listings_dashboard_counts(uuid, uuid, text, numeric, integer);

CREATE OR REPLACE FUNCTION public.get_listings_dashboard_counts(p_organization_id uuid, p_ml_account_id uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_preco_teto numeric DEFAULT NULL::numeric, p_queda_dias integer DEFAULT NULL::integer, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_ml_account_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(total bigint, active bigint, paused bigint, out_of_stock bigint, in_full bigint, unlinked bigint, in_promotion bigint, without_promotion bigint, promotion_unknown bigint, preco_divergente bigint, em_queda bigint, precisam_atencao bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  -- C-85: o N da queda pelas datas, a MESMA regra da lista (periodo de 7, 15,
  -- 30, 60 ou 90 dias terminando hoje), e nao pelo p_queda_dias: a faixa e a
  -- lista nunca divergem. Sem as cinco reguas, `precisam_atencao` e NULA.
  v_atencao_dias integer := case
    when p_date_from is not null and p_date_to = (now() at time zone 'America/Sao_Paulo')::date
      then p_date_to - p_date_from + 1
  end;
  v_atencao boolean := p_preco_teto is not null and p_preco_teto >= 0
    and coalesce(v_atencao_dias in (7, 15, 30, 60, 90), false);
begin
  -- C-80: varias contas. Vazio nao e "todas" (seria um defeito da tela), e
  -- conta e contas juntas tambem: a tela manda um ou outro.
  if p_ml_account_ids is not null and cardinality(p_ml_account_ids) = 0 then
    raise exception 'p_ml_account_ids vazio: sem conta escolhida, nao mande o parametro';
  end if;

  if p_ml_account_ids is not null and p_ml_account_id is not null then
    raise exception 'p_ml_account_id e p_ml_account_ids juntos: mande um ou outro';
  end if;

  return query
  with vinculos as (
    select distinct k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
  ),
  -- C-85: vendeu no periodo, a mesma soma da lista (por conta e anuncio, entre
  -- as datas, variacoes juntas). So com as cinco reguas.
  vendas_no_periodo as (
    select m.ml_account_id, m.mlb_id
    from public.daily_listing_metrics m
    where v_atencao
      and m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
    group by m.ml_account_id, m.mlb_id
    having sum(m.units_sold) > 0
  ),
  acoes_abertas as (
    select distinct ac.ml_account_id, ac.mlb_id
    from public.actions ac
    where v_atencao
      and ac.organization_id = p_organization_id
      and ac.status in ('novo', 'em_andamento')
      and ac.ml_account_id is not null
      and ac.mlb_id is not null
  ),
  full_ultimo as (
    -- A mesma definicao canonica de Full de `get_listings_dashboard` (D-173/D-204).
    select distinct on (f.ml_account_id, f.inventory_id)
           f.ml_account_id, f.item_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_por_anuncio as (
    select u.ml_account_id, u.item_id, sum(u.quantity) as full_quantity
    from full_ultimo u
    group by u.ml_account_id, u.item_id
  ),
  -- C-77 (D-625): o conjunto de anuncios de um SKU e o de get_sku_listings
  -- (D-122): listings.sku_id uniao o vinculo ITEM, inclusive o por variacao
  -- (o preco e o do ITEM). So ATIVO ou PAUSADO -- o encerrado fica fora, a
  -- decisao do A2/A3 de 21/10, a mesma do diagnostico do SKU (D-630).
  anuncio_sku as (
    select l.sku_id, l.ml_account_id, l.item_id
    from public.listings l
    where l.organization_id = p_organization_id
      and l.sku_id is not null
    union
    select k.sku_id, k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
      and k.ref_kind = 'ITEM'
      and k.item_id is not null
  ),
  -- O preco que chega ao comprador: o promocional, senao o cadastrado
  -- (D-389), o mesmo `precoEfetivo` do diagnostico do SKU.
  preco_sku as (
    select x.sku_id,
           min(coalesce(pl.promotional_price, pl.price)) as preco_minimo,
           max(coalesce(pl.promotional_price, pl.price)) as preco_maximo,
           count(*)::integer as anuncios_com_preco
    from anuncio_sku x
    join public.listings pl
      on pl.organization_id = p_organization_id
     and pl.ml_account_id = x.ml_account_id
     and pl.item_id = x.item_id
    where pl.status in ('active', 'paused')
      and coalesce(pl.promotional_price, pl.price) is not null
    group by x.sku_id
  ),
  -- A dispersao CHEIA: (maior - menor) / menor x 100, so com dois precos ou
  -- mais. Menor zero da 0, como no diagnostico. O arredondamento e so da
  -- exibicao; o filtro e a ordem comparam o valor cheio (D-630).
  dispersao_sku as (
    select p.sku_id, p.preco_minimo, p.preco_maximo, p.anuncios_com_preco,
           case when p.preco_minimo = 0 then 0::numeric
                else (p.preco_maximo - p.preco_minimo) / p.preco_minimo * 100 end as dispersao_cheia
    from preco_sku p
    where p.anuncios_com_preco >= 2
  ),
  -- O anuncio vinculado por variacao pode ter varios SKUs: a linha leva o
  -- de MAIOR dispersao, e diz qual.
  dispersao_anuncio as (
    select distinct on (x.ml_account_id, x.item_id)
           x.ml_account_id, x.item_id, d.sku_id, d.preco_minimo, d.preco_maximo,
           d.anuncios_com_preco, d.dispersao_cheia
    from anuncio_sku x
    join dispersao_sku d on d.sku_id = x.sku_id
    order by x.ml_account_id, x.item_id, d.dispersao_cheia desc, d.sku_id
  ),
  escopo as (
    -- O ESCOPO da faixa e conta + busca, sem filtro de estado: cada celula E
    -- um filtro de estado (mesmo raciocinio da tela desde D-242).
    select l.status, l.available_quantity, l.sku_id, kv.item_id as vinculo_por_variacao,
           fa.full_quantity, l.in_promotion as em_promocao, da.dispersao_cheia,
           qd.estado as estado_da_queda,
           vp.mlb_id is not null as vendeu,
           aa.mlb_id is not null as acao_aberta,
           qa.estado as queda_do_periodo
    from public.listings l
    join public.ml_accounts a on a.id = l.ml_account_id
    left join public.skus s on s.id = l.sku_id
    left join vinculos kv on kv.ml_account_id = l.ml_account_id and kv.item_id = l.item_id
    left join full_por_anuncio fa on fa.ml_account_id = l.ml_account_id and fa.item_id = l.item_id
    left join dispersao_anuncio da on da.ml_account_id = l.ml_account_id and da.item_id = l.item_id
    left join public.listing_sales_drop qd
      on qd.ml_account_id = l.ml_account_id
     and qd.item_id = l.item_id
     and qd.periodo_dias = p_queda_dias
    left join vendas_no_periodo vp on vp.ml_account_id = l.ml_account_id and vp.mlb_id = l.item_id
    left join acoes_abertas aa on aa.ml_account_id = l.ml_account_id and aa.mlb_id = l.item_id
    left join public.listing_sales_drop qa
      on qa.ml_account_id = l.ml_account_id
     and qa.item_id = l.item_id
     and qa.periodo_dias = v_atencao_dias
    where l.organization_id = p_organization_id
      -- D-631: o anuncio excluido no Mercado Livre sai da tela.
      and l.deleted_at is null
      and (p_ml_account_id is null or l.ml_account_id = p_ml_account_id)
      -- C-80: as contas escolhidas, a mesma regra da lista.
      and (p_ml_account_ids is null or l.ml_account_id = any(p_ml_account_ids))
      and (p_search is null
           or l.item_id ilike '%' || p_search || '%'
           or l.title   ilike '%' || p_search || '%'
           or s.sku     ilike '%' || p_search || '%')
  )
  select
    count(*),
    count(*) filter (where e.status = 'active'),
    count(*) filter (where e.status = 'paused'),
    -- = p_stock 'out'
    count(*) filter (where e.available_quantity = 0),
    -- = p_full 'with'
    count(*) filter (where coalesce(e.full_quantity, 0) > 0),
    -- = p_link_state 'unlinked': nem por anuncio nem por variacao (D-122)
    count(*) filter (where e.sku_id is null and e.vinculo_por_variacao is null),
    -- = p_promo 'with' / 'without'; o resto dos ativos e o NAO LIDO.
    count(*) filter (where e.status = 'active' and e.em_promocao is true),
    count(*) filter (where e.status = 'active' and e.em_promocao is false),
    count(*) filter (where e.status = 'active' and e.em_promocao is null),
    -- = p_preco 'divergente' com o mesmo teto.
    case when p_preco_teto is null then null
         else count(*) filter (where e.dispersao_cheia > p_preco_teto) end,
    -- = p_queda 'queda' no mesmo periodo.
    case when p_queda_dias is null then null
         else count(*) filter (where e.estado_da_queda = 'queda') end,
    -- C-85: o OU das cinco, o mesmo da lista, so em ativo e pausado.
    case when not v_atencao then null
         else count(*) filter (where e.status in ('active', 'paused') and (
                (e.available_quantity = 0 and e.vendeu)
             or (e.sku_id is null and e.vinculo_por_variacao is null and e.vendeu)
             or e.acao_aberta
             or e.queda_do_periodo = 'queda'
             or e.dispersao_cheia > p_preco_teto)) end
  from escopo e;
end;
$function$;

comment on function public.get_listings_dashboard_counts(uuid, uuid, text, numeric, integer, date, date, uuid[]) is
  'A faixa de /anuncios: C-77 preco_divergente, C-79 em_queda, C-80 p_ml_account_ids e C-85 precisam_atencao (com p_date_from/p_date_to; NULA sem o teto e a queda do periodo).';

revoke all on function public.get_listings_dashboard_counts(uuid, uuid, text, numeric, integer, date, date, uuid[]) from public, anon;
grant execute on function public.get_listings_dashboard_counts(uuid, uuid, text, numeric, integer, date, date, uuid[]) to authenticated, service_role;
