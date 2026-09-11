-- ============================================================
-- `get_sku_curation` ganha ORDEM e as duas datas (D-315).
--
-- Pedido do dono do produto, com o print do UpSeller ao lado: a lista de
-- produtos precisa das mesmas opcoes de la -- escolher quantos itens por
-- pagina e escolher a ordem.
--
-- O QUE MUDA
--
--   p_order        argumento novo, no FIM da assinatura. 'curadoria' (o
--                  padrao, identico a ordem que a tela sempre teve),
--                  'atualizado' e 'criado'.
--   created_at     colunas novas no `returns table`, tambem no fim. A tela
--   updated_at     passa a MOSTRAR a coluna "Criado/Atualizado" do UpSeller.
--
-- POR QUE A ORDEM MORA NA FUNCAO, E NAO NA TELA. A lista e PAGINADA: ordenar
-- as 50 linhas que chegaram ordenaria a pagina, nao o conjunto. O `total_count`
-- ja vinha de `count(*) over ()` pelo mesmo motivo (D-138).
--
-- O DESEMPATE POR `f.sku` VALE EM TODA ORDEM, e nao e detalhe: `updated_at`
-- repete entre linhas com facilidade (uma importacao do ERP grava o mesmo
-- instante em centenas de SKUs), e ordem nao determinista com OFFSET faz a
-- paginacao repetir e pular linhas -- o operador ve o mesmo SKU em duas
-- paginas e nunca ve um terceiro.
--
-- ASSINATURA: conferida nas duas metades antes de escrever (D-237).
--   catalogo   nenhuma funcao SQL chama `get_sku_curation`
--   monorepo   `apps/web/app/produtos/page.tsx` (por NOME) e a suite de
--              integracao (por POSICAO, no SQL) -- por isso o argumento entra
--              por ultimo e as duas colunas novas tambem.
--
-- O corpo abaixo foi EXTRAIDO DO ARQUIVO da migration anterior
-- (`20260904194000_sku_curation_listing_count.sql`) e nao transcrito a mao; as
-- alteracoes sao as quatro acima e mais nada.
-- ============================================================

drop function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer);

create function public.get_sku_curation(
  p_organization_id uuid,
  p_brand text default null,
  p_missing_brand boolean default false,
  p_classified text default null,
  p_signal text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0,
  -- 'curadoria' (o padrao, e a ordem que esta tela sempre teve) |
  -- 'atualizado' | 'criado'. Entra por ULTIMO: quem nao passa continua
  -- igual, e as chamadas posicionais existentes nao se deslocam (D-242).
  -- Valor desconhecido cai em 'curadoria', nunca numa ordem vazia.
  p_order text default 'curadoria'
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  brand text,
  supplier_brand text,
  supplier_brand_source text,
  supplier_brand_set_at timestamptz,
  stock_is_virtual boolean,
  stock_is_virtual_set_at timestamptz,
  snapshot_available numeric,
  snapshot_captured_at timestamptz,
  has_sentinel_signature boolean,
  units_sold_90d bigint,
  decision_diverges_from_signature boolean,
  total_count bigint,
  listing_count bigint,
  -- Saem para a tela porque agora ELAS ordenam: ordenar por uma data que
  -- a tabela nao mostra e pedir para o operador acreditar sem conferir.
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.check_sku_curation_writer(p_organization_id);

  return query
  with retrato as (
    select distinct on (s.sku_id, s.warehouse)
      s.sku_id, s.warehouse, s.available, s.captured_at
    from public.erp_stock_snapshots s
    where s.organization_id = p_organization_id
      and s.sku_id is not null
    order by s.sku_id, s.warehouse, s.captured_at desc
  ),
  retrato_agg as (
    select r.sku_id, sum(r.available) as available, max(r.captured_at) as captured_at
    from retrato r
    group by r.sku_id
  ),
  vendas as (
    select m.sku_id, sum(m.units_sold)::bigint as units_sold_90d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date >= (current_date - 89)
    group by m.sku_id
  ),
  anuncios as (
    -- Anuncios que vendem o SKU: vinculo direto OU por variacao, uma vez por
    -- (conta, anuncio) — a definicao de "vinculado" de /anuncios (D-122).
    select u.sku_id, count(*)::bigint as listing_count
    from (
      select l.sku_id, l.ml_account_id, l.item_id
      from public.listings l
      where l.organization_id = p_organization_id and l.sku_id is not null
      union
      select k.sku_id, k.ml_account_id, k.item_id
      from public.sku_listing_links k
      where k.organization_id = p_organization_id and k.ref_kind = 'ITEM' and k.item_id is not null
    ) u
    group by u.sku_id
  ),
  base as (
    select
      k.id as sku_id,
      k.sku,
      k.title,
      k.brand,
      k.supplier_brand,
      k.supplier_brand_source,
      k.supplier_brand_set_at,
      k.stock_is_virtual,
      k.stock_is_virtual_set_at,
      k.sku_key,
      k.created_at,
      k.updated_at,
      ra.available as snapshot_available,
      ra.captured_at as snapshot_captured_at,
      case
        when ra.sku_id is null then null
        else (ra.available between 900 and 1000 or ra.available between 9900 and 10000)
      end as has_sentinel_signature,
      coalesce(v.units_sold_90d, 0)::bigint as units_sold_90d,
      coalesce(an.listing_count, 0)::bigint as listing_count
    from public.skus k
    left join retrato_agg ra on ra.sku_id = k.id
    left join vendas v on v.sku_id = k.id
    left join anuncios an on an.sku_id = k.id
    where k.organization_id = p_organization_id
  ),
  marcada as (
    select
      b.*,
      (b.stock_is_virtual_set_at is not null
        and b.has_sentinel_signature is not null
        and b.stock_is_virtual <> b.has_sentinel_signature) as decision_diverges_from_signature
    from base b
  ),
  filtrada as (
    select m.* from marcada m
    where (p_brand is null or m.supplier_brand = p_brand)
      and (not coalesce(p_missing_brand, false) or m.supplier_brand is null)
      and (
        p_classified is null
        or (p_classified = 'PENDENTE' and m.stock_is_virtual_set_at is null)
        or (p_classified = 'VIRTUAL' and m.stock_is_virtual_set_at is not null and m.stock_is_virtual)
        or (p_classified = 'FISICO' and m.stock_is_virtual_set_at is not null and not m.stock_is_virtual)
      )
      and (
        p_signal is null
        or (p_signal = 'SENTINELA' and m.has_sentinel_signature)
        or (p_signal = 'SEM_SINAL' and m.has_sentinel_signature is false)
        or (p_signal = 'SEM_RETRATO' and m.has_sentinel_signature is null)
        or (p_signal = 'DIVERGENTE' and m.decision_diverges_from_signature)
      )
      and (
        p_search is null
        or pg_catalog.btrim(p_search) = ''
        or m.sku_key like pg_catalog.upper(pg_catalog.btrim(p_search)) || '%'
        or m.title ilike '%' || pg_catalog.btrim(p_search) || '%'
      )
  )
  select
    f.sku_id, f.sku, f.title, f.brand,
    f.supplier_brand, f.supplier_brand_source, f.supplier_brand_set_at,
    f.stock_is_virtual, f.stock_is_virtual_set_at,
    f.snapshot_available, f.snapshot_captured_at,
    f.has_sentinel_signature, f.units_sold_90d, f.decision_diverges_from_signature,
    (count(*) over ())::bigint as total_count,
    f.listing_count,
    f.created_at, f.updated_at
  from filtrada f
  order by
    -- A data escolhida manda; nas outras ordens este termo e NULO e nao
    -- interfere.
    case when p_order = 'atualizado' then f.updated_at
         when p_order = 'criado'     then f.created_at end desc nulls last,
    -- A ordem de CURADORIA (divergente primeiro, depois sentinela) so vale
    -- quando nenhuma data foi pedida -- e vale tambem para valor
    -- desconhecido, que e o que o `is null` cobre.
    (case when p_order not in ('atualizado', 'criado') or p_order is null
          then f.decision_diverges_from_signature end) desc nulls last,
    (case when p_order not in ('atualizado', 'criado') or p_order is null
          then f.has_sentinel_signature end) desc nulls last,
    -- DESEMPATE ESTAVEL, em toda ordem: `updated_at` repetido entre linhas
    -- (uma importacao inteira grava o mesmo instante) deixaria a paginacao
    -- livre para repetir ou pular SKU entre paginas.
    f.sku
  limit greatest(coalesce(p_limit, 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer, text) is
  'Mesa de curadoria (D-133/D-245): universo = todas as linhas de skus da organizacao; retrato mais recente do ERP por SKU; assinatura de sentinela (900-1000 / 9900-10000) como TERCEIRO estado quando nao ha retrato; vendas de 90 dias; divergencia entre decisao e assinatura; listing_count = anuncios que vendem o SKU (vinculo direto OU por variacao, definicao de /anuncios, D-122). Desde D-315 aceita p_order (curadoria | atualizado | criado) e devolve created_at/updated_at, com desempate estavel por sku. SECURITY DEFINER com guarda private.check_sku_curation_writer.';

-- O Postgres da EXECUTE a PUBLIC em toda funcao nova (D-182/D-242): revogar
-- ANTES do grant, senao `anon` alcanca a RPC.
revoke execute on function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer, text) from public, anon;
grant execute on function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer, text) to authenticated, service_role;
