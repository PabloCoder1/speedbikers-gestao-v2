-- ============================================================
-- `get_price_changes` ganha a FAIXA de /precos e a data real do inicio da
-- serie (D24, D-264).
--
-- ------------------------------------------------------------
-- POR QUE ESTENDER, e nao criar uma funcao de resumo
-- ------------------------------------------------------------
-- O frame `IntelligenceScreen type="pricing"` desenha quatro cartoes acima da
-- tabela: Alteracoes, Aumentos, Reducoes e Anuncios Afetados. Os quatro contam
-- **o mesmo recorte que a tabela mostra** -- mesmo filtro de data, conta,
-- direcao e busca. Uma funcao separada seria um segundo dono do numero (D-224)
-- e uma segunda ida ao banco (D-185), para contar exatamente as linhas que esta
-- ja recorta.
--
-- As tres contagens saem de UMA passada sobre `filtrado`, num `cross join` com
-- a CTE `resumo` -- nao de tres subconsultas escalares, que varreriam a CTE
-- tres vezes. `total_count` migrou para la junto, pelo mesmo motivo.
--
-- ------------------------------------------------------------
-- SEM LINHA-SENTINELA AQUI, e o contraste com D-263 e o ponto
-- ------------------------------------------------------------
-- Em `get_actions_queue` (D-263) a pagina vazia PRECISA devolver uma linha,
-- porque o painel de filtros conta um conjunto DIFERENTE do que a fila mostra
-- (o inbox inteiro): sem a linha, o painel some e zero seria mentira.
--
-- Aqui e o oposto. Os quatro cartoes contam **o mesmo conjunto** da tabela.
-- Recorte que nao casa nada tem, de verdade, 0 alteracoes, 0 aumentos, 0
-- reducoes e 0 anuncios afetados -- entao "nenhuma linha" e o TypeScript
-- assumindo zero e a resposta correta, nao uma ausencia disfarcada (D-067).
-- Acrescentar sentinela aqui quebraria a aba Precos do SKU (D-226), que e o
-- segundo consumidor desta funcao, por uma linha fantasma que ela nao pediu.
--
-- ------------------------------------------------------------
-- `series_start`: a data estava CRAVADA NO CODIGO, e por organizacao
-- ------------------------------------------------------------
-- `apps/web/app/precos/page.tsx` trazia `SERIES_START_LABEL = "24/08/2026"`, e
-- o comentario desta propria funcao repetia "a serie comeca em 2026-08-24". A
-- data e verdadeira -- medido: o evento mais antigo do Dev e 2026-08-24 -- mas
-- ela e uma propriedade DA ORGANIZACAO, nao do produto: a serie de cada uma
-- comeca quando a sincronizacao dela comecou.
--
-- Hoje so uma organizacao tem evento de preco, entao o defeito e **latente,
-- nao vivo**. E a classe de D-234, que custou 26 telas quebrando no SEGUNDO
-- usuario: o numero cravado esta certo enquanto houver um so.
--
-- `series_start` sai de `min(occurred_at)` sobre os eventos de preco DA
-- ORGANIZACAO, **sem** os filtros de data/conta/direcao/busca -- a ressalva
-- fala do inicio da SERIE, nao do recorte. Por isso e subconsulta propria, e
-- nao mais uma coluna do `resumo`.
--
-- ------------------------------------------------------------
-- O QUE ESTA FUNCAO CONTINUA NAO FAZENDO
-- ------------------------------------------------------------
-- Nao calcula impacto antes/depois. O frame traz um aviso pronto dizendo que o
-- sistema "apresentara tendencias quando o volume de dados estabilizar
-- (geralmente apos 7 dias da mudanca)" -- **nada implementa isso**, e prometer
-- comportamento futuro com prazo e pior do que nao prometer nada. A tela ja
-- dizia a verdade equivalente, sem prazo, desde D-172.
--
-- E ausencia de linha continua NAO sendo preco estavel: o evento e diff entre
-- snapshots de 6 em 6 horas, entao mudanca feita e desfeita entre duas
-- varreduras nao deixa registro (D-226).
--
-- ------------------------------------------------------------
-- ASSINATURA: os ARGUMENTOS nao mudam
-- ------------------------------------------------------------
-- So a tabela de retorno cresce, entao os dois chamadores existentes
-- (`/precos` e a aba Precos de `/skus/[skuId]`) seguem funcionando sem tocar
-- em nada -- eles selecionam por NOME. DROP + CREATE porque mudar `returns
-- table` exige, e o corpo abaixo foi EXTRAIDO do arquivo anterior, nao
-- redigitado (licao de D-259).
-- ============================================================

drop function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer);

create function public.get_price_changes(
  p_organization_id uuid,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_ml_account_id uuid default null,
  -- 'up' | 'down' | null. Valor desconhecido cai em "sem filtro" -- a tela
  -- valida antes, mas a funcao nao depende disso.
  p_direction text default null,
  p_search text default null,
  p_sku_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  event_id uuid,
  item_id text,
  title text,
  status text,
  sku_id uuid,
  sku text,
  ml_account_id uuid,
  account_label text,
  price_before numeric,
  price_after numeric,
  delta numeric,
  delta_ratio numeric,
  occurred_at timestamptz,
  total_count bigint,
  increases bigint,
  decreases bigint,
  listings_affected bigint,
  -- DATE, nao timestamptz: e um DIA CIVIL, e a conversao de fuso mora aqui.
  -- Do lado do TypeScript, `formatBusinessDate` so aceita `YYYY-MM-DD` e
  -- recusa qualquer coisa com hora -- exatamente para impedir que alguem passe
  -- um instante por `new Date(...)` e desloque o dia (meia-noite UTC e 21h do
  -- dia anterior em Sao Paulo). Entregar o dia pronto e o que torna esse erro
  -- impossivel de cometer.
  series_start date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select
      e.id as event_id,
      e.entity_id as item_id,
      -- LEFT join: o anuncio pode ter sumido do catalogo depois do evento.
      -- O evento continua sendo verdade -- a tela mostra o MLB sem titulo em
      -- vez de esconder a linha.
      l.title,
      l.status,
      l.sku_id,
      s.sku,
      e.ml_account_id,
      a.label as account_label,
      (e.before ->> 'price')::numeric as price_before,
      (e.after  ->> 'price')::numeric as price_after,
      e.occurred_at
    from public.domain_events e
    join public.ml_accounts a on a.id = e.ml_account_id
    left join public.listings l
      on l.ml_account_id = e.ml_account_id and l.item_id = e.entity_id
    left join public.skus s on s.id = l.sku_id
    where e.organization_id = p_organization_id
      and e.event_type = 'listing.price.changed'
      and e.occurred_at >= p_date_from
      and e.occurred_at < p_date_to
      -- Evento sem os dois lados do preco nao vira linha com NULL silencioso:
      -- fica de fora, porque "de quanto para quanto" e a pergunta da tela.
      and e.before ? 'price'
      and e.after ? 'price'
      and (p_ml_account_id is null or e.ml_account_id = p_ml_account_id)
      -- Ver o cabecalho: equivalente a `l.sku_id = p_sku_id` pela unicidade de
      -- `(ml_account_id, item_id)`, e 5,5x mais barato quando ha filtro.
      and (p_sku_id is null
           or (e.ml_account_id, e.entity_id) in (
                select k.ml_account_id, k.item_id
                from public.listings k
                where k.sku_id = p_sku_id))
      and (p_search is null
           or e.entity_id ilike '%' || p_search || '%'
           or l.title ilike '%' || p_search || '%'
           or s.sku ilike '%' || p_search || '%')
  ),
  filtrado as (
    select * from base
    where case p_direction
            when 'up'   then price_after > price_before
            when 'down' then price_after < price_before
            else true
          end
  )  ,
  -- UMA passada sobre `filtrado` para as quatro contagens. Tres subconsultas
  -- escalares dariam a mesma resposta varrendo a CTE tres vezes.
  resumo as (
    select
      count(*)::bigint                                              as total_count,
      count(*) filter (where price_after > price_before)::bigint    as increases,
      count(*) filter (where price_after < price_before)::bigint    as decreases,
      count(distinct item_id)::bigint                               as listings_affected
    from filtrado
  )
  select
    f.event_id, f.item_id, f.title, f.status, f.sku_id, f.sku,
    f.ml_account_id, f.account_label, f.price_before, f.price_after,
    round(f.price_after - f.price_before, 2) as delta,
    round((f.price_after - f.price_before) / nullif(f.price_before, 0), 4) as delta_ratio,
    f.occurred_at,
    r.total_count,
    r.increases,
    r.decreases,
    r.listings_affected,
    -- FORA do recorte de proposito: a ressalva da tela fala do inicio da SERIE
    -- da organizacao, nao do filtro escolhido. Os mesmos predicados de
    -- `base` que definem "e um evento de preco utilizavel", sem data, conta,
    -- direcao nem busca.
    -- O fuso e o da organizacao por definicao canonica: `metric_definitions`
    -- tem `check (timezone = 'America/Sao_Paulo')` desde a Fase 0. Converter
    -- aqui, e nao no navegador, mantem uma definicao de "que dia e esse".
    (select (min(e2.occurred_at) at time zone 'America/Sao_Paulo')::date
       from public.domain_events e2
      where e2.organization_id = p_organization_id
        and e2.event_type = 'listing.price.changed'
        and e2.before ? 'price'
        and e2.after ? 'price') as series_start
  from filtrado f
  cross join resumo r
  order by f.occurred_at desc, f.event_id desc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

comment on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer) is
  'Mudancas de preco observadas por anuncio (D-172, Central de Precos; p_sku_id desde D-226; faixa de KPIs e series_start desde D-264). delta_ratio e FRACAO (convencao de D-170), NULL se o preco anterior era zero. As quatro contagens (total_count, increases, decreases, listings_affected) saem de UMA passada sobre o conjunto FILTRADO -- o mesmo recorte que a tabela mostra, para cabecalho e corpo nao discordarem (D-236). NAO ha linha-sentinela como em D-263: la o painel contava um conjunto diferente da fila, aqui os cartoes contam o MESMO, entao recorte vazio tem de verdade quatro zeros e o TypeScript assume zero sem mentir. series_start ignora os filtros de proposito: e o inicio da serie DA ORGANIZACAO, e estava cravado no codigo como constante -- certo para a unica org com dado, errado para a segunda (classe D-234). O filtro de SKU entra por `in` sobre os anuncios do SKU: mesma resposta pela unicidade de (ml_account_id, item_id), 5,5x menos buffers com filtro. NAO calcula impacto antes/depois -- comparar venda dos dois lados exigiria janela comparavel que a serie nao tem, e o aviso do frame que promete tendencias "apos 7 dias" nao corresponde a nada implementado. Ausencia de linha NAO e preco estavel: o evento e diff entre snapshots de 6 em 6 horas. security invoker.';

revoke all on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer) from public, anon;
grant execute on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer) to authenticated, service_role;
