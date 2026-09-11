-- ============================================================
-- `get_sku_curation` ganha `force_custom_plan` (D-319).
--
-- O gatilho foi uma pergunta do dono do produto: `/produtos` parecia lenta, e
-- D-315 baixou a pagina de 100 para 50 "para ver se isso deixa mais rapido o
-- site". A medicao mostrou que o tamanho da pagina nao tem nada a ver -- e
-- achou outra coisa.
--
-- ------------------------------------------------------------
-- O SALTO NA SEXTA EXECUCAO
-- ------------------------------------------------------------
-- Oito chamadas identicas, na MESMA conexao, como usuario autenticado, com
-- catalogo sintetico de 3.502 SKUs. Tres repeticoes do ensaio:
--
--   1a a 5a    15 - 36 ms
--   6a a 8a    360 - 550 ms        <- 20x a 25x, e sempre a partir da sexta
--
-- A funcao e `language plpgsql` e nao tinha `plan_cache_mode`: o SPI planeja
-- CUSTOM nas cinco primeiras execucoes de uma conexao e pode migrar para o
-- GENERICO na sexta -- e o generico planeja sem os valores dos argumentos,
-- erra as estimativas e escolhe o plano errado.
--
-- **A MAGNITUDE VARIA COM A ESTATISTICA, o salto nao.** Numa PRIMEIRA carga de
-- dados sintetica, com a mesma forma e o mesmo volume, a sexta media 3.938 ms
-- (e a 7a e a 8a, 4.110 e 4.077) -- 230x. Noutra carga, 360-550 ms. O numero
-- absoluto dessa penalidade e sorteado pelo plano que o generico escolhe; o
-- que se repetiu em TODAS as medicoes foi a existencia do salto e o fato de
-- ele comecar na sexta. Por isso este cabecalho registra faixa, e nao um
-- numero de sorte.
--
-- Uma medicao de UMA execucao nao veria nada: mediria 20 ms e iria embora
-- feliz. E a tela real e pior que qualquer teste, porque o pool do PostgREST
-- reusa conexoes -- **quem paga e o usuario de sempre, na conexao quente**,
-- nao o primeiro da manha.
--
-- ------------------------------------------------------------
-- A FATIA ANTERIOR NAO CAUSOU ISSO -- conferido, nao suposto
-- ------------------------------------------------------------
-- D-315 acrescentou `p_order` e duas datas, e o `order by` novo tem `case`.
-- Era plausivel que o plano generico tivesse piorado por causa dele. Medido no
-- MESMO volume, restaurando a definicao anterior (a de `20260904194000`):
--
--   antes de D-315    24 - 34 ms  ->  412 - 526 ms na 6a
--   depois de D-315   15 - 36 ms  ->  360 - 550 ms na 6a
--
-- Ou seja: **a doenca ja estava la**, e a fatia anterior nao a piorou.
--
-- ------------------------------------------------------------
-- O QUE A MESMA MEDICAO DESMENTIU
-- ------------------------------------------------------------
-- Com o plano generico no lugar, nada que a tela ESCOLHE muda o custo:
--
--   20 por pagina    4.032 ms        100 por pagina   3.926 ms
--   50 por pagina    3.917 ms        300 por pagina   4.030 ms
--
-- (numeros da primeira carga, a de 3.938 ms). Nem a ordem (curadoria 3.958 /
-- atualizado 3.934 / criado 3.930), nem o offset alto (4.127 na pagina 61),
-- nem tirar o filtro de estado (3.967). **A mudanca de 100 para 50 de D-315
-- nao deixou nada mais rapido** -- ela vale pelo que e, uma opcao que o dono
-- pediu, nao como otimizacao.
--
-- Depois desta linha, tres repeticoes de oito execucoes: 16 - 34 ms do
-- comeco ao fim, sem salto na sexta.
--
-- `get_sku_curation_summary`, que roda no mesmo `Promise.all` da tela, mede
-- 5,7-6,8 ms e nao entra nesta correcao.
--
-- ------------------------------------------------------------
-- POR QUE A VARREDURA DE D-307 NAO PEGOU ESTA
-- ------------------------------------------------------------
-- Pegou de raspao, e deixou passar pelo motivo que a propria D-307 escreveu.
--
-- Na tabela de D-305, tirada do `pg_stat_statements` do Dev, esta funcao
-- aparece como **a unica `plpgsql` da lista, e a mais rapida: 200 ms de media,
-- 786 ms de pior caso**. Ela sustentou a generalizacao "toda RPC lenta aqui e
-- `language sql`" -- que D-306 depois desfez. E, por parecer saudavel, ficou
-- FORA das 19 varridas em D-307: nao esta entre as 16 declaradas sadias la.
--
-- A licao de D-307 era exatamente esta: **`pg_stat_statements` mede o que foi
-- chamado, nao o que pode ser chamado**. Media de producao nao e cobertura. A
-- funcao parecia barata porque ninguem tinha exercitado a forma cara dela na
-- conexao certa.
--
-- **Fica a pergunta aberta:** quantas outras `plpgsql` sem `plan_cache_mode`
-- estao assim? A varredura de D-307 mediu `language sql` com o criterio certo
-- para aquela linguagem (estado estavel desproporcional), mas para `plpgsql` o
-- sinal e outro -- a sexta execucao --, e essa varredura nao foi feita.
--
-- ------------------------------------------------------------
-- MEDIDO ONDE, E O QUE ISSO NAO PROVA
-- ------------------------------------------------------------
-- No Postgres LOCAL, com catalogo SINTETICO de 3.502 SKUs, 8.400 retratos do
-- ERP (tres por SKU, para o `distinct on` custar de verdade), 12.608 linhas de
-- metrica, 5.005 anuncios e datas espalhadas em 423 dias distintos.
--
-- **Os milissegundos absolutos nao valem para o Dev** -- maquina diferente,
-- dado diferente, e a propria medicao mostrou que a magnitude depende da
-- estatistica. O que vale, e independe disso, e a FORMA: o salto comeca na
-- sexta, e o tamanho da pagina nao importa. A cura tem dois precedentes
-- medidos no Dev (D-305, D-307).
--
-- O corpo abaixo foi EXTRAIDO DO ARQUIVO da migration anterior
-- (`20260911210000_sku_curation_order_and_dates.sql`) e nao transcrito a mao; a
-- unica alteracao e a linha de `plan_cache_mode`.
-- ============================================================

drop function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer, text);

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
-- A LINHA QUE TIRA O SALTO DA SEXTA EXECUCAO (D-319). Ver o cabecalho: sem
-- ela o SPI migra para o plano GENERICO a partir da sexta chamada da conexao,
-- e o generico planeja sem os valores dos argumentos.
set plan_cache_mode = 'force_custom_plan'
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
  'Mesa de curadoria (D-133/D-245): universo = todas as linhas de skus da organizacao; retrato mais recente do ERP por SKU; assinatura de sentinela (900-1000 / 9900-10000) como TERCEIRO estado quando nao ha retrato; vendas de 90 dias; divergencia entre decisao e assinatura; listing_count = anuncios que vendem o SKU (vinculo direto OU por variacao, definicao de /anuncios, D-122). Desde D-315 aceita p_order (curadoria | atualizado | criado) e devolve created_at/updated_at, com desempate estavel por sku. force_custom_plan desde D-319: sem ele o SPI migrava para o plano generico a partir da SEXTA execucao da conexao e a chamada da tela saltava de ~20 ms para 360-4.000 ms conforme a estatistica -- o tamanho da pagina nao tinha nada a ver. SECURITY DEFINER com guarda private.check_sku_curation_writer.';

-- O Postgres da EXECUTE a PUBLIC em toda funcao nova (D-182/D-242): revogar
-- ANTES do grant, senao `anon` alcanca a RPC.
revoke execute on function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer, text) from public, anon;
grant execute on function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer, text) to authenticated, service_role;
