-- ============================================================
-- `get_price_changes` ganha `p_sku_id` (aba Precos do Dashboard de SKU).
--
-- ZERO logica nova: a RPC de D-172 ja devolve `sku_id` em cada linha. Faltava
-- so poder FILTRAR por ele. Como `create or replace` nao muda lista de
-- argumentos -- criaria uma sobrecarga, e chamada que omite os defaults
-- ficaria ambigua --, a funcao e derrubada e recriada. A ACL vai junto
-- (D-211: o default de function nao e o que se espera).
--
-- `p_sku_id` entra DEPOIS de `p_search` e ANTES de `p_limit`, a mesma ordem de
-- `get_fulfillment_overview`: filtros primeiro, paginacao por ultimo.
--
-- ------------------------------------------------------------
-- POR QUE `in` SOBRE OS ANUNCIOS, E NAO `l.sku_id = p_sku_id`
-- ------------------------------------------------------------
-- A forma obvia -- e a que a casa usa em `get_fulfillment_overview` -- seria
-- `and (p_sku_id is null or l.sku_id = p_sku_id)`. Medido no Dev, ela NAO
-- funciona aqui, e a diferenca e estrutural: la o filtro cai sobre a tabela
-- que DIRIGE a consulta; aqui `l` entra por `left join`, entao o planejador le
-- todos os eventos de preco da organizacao e so depois descarta.
--
-- Medido no Dev (206 eventos, 168 anuncios, 4 anuncios no SKU de teste), com
-- `explain (analyze, buffers)` QUENTE nos quatro planos:
--
--   forma                      p_sku_id nulo      p_sku_id preenchido
--   -------------------------  -----------------  --------------------
--   l.sku_id = p_sku_id        960 buffers        960 buffers
--   in (esta)                  960 -- IDENTICO    173 buffers
--
-- Ou seja: **ganha 5,5x onde importa e EMPATA onde nao importa**. Com
-- `p_sku_id` nulo o `or` curto-circuita, o subplano some do plano e a Central
-- de Precos fica com o plano que ja tinha -- nao ha regressao a pagar pela aba
-- nova. Com `p_sku_id` preenchido o planejador monta um *hashed SubPlan* com
-- os anuncios do SKU e filtra os eventos contra ele, em vez de sondar
-- `listings` uma vez por evento.
--
-- Nem com valor literal o planejador entra por `listings_sku_idx` na forma
-- antiga -- conferido, para nao atribuir a diferenca a plano generico.
--
-- A IGUALDADE E ESTRUTURAL, nao empirica (a exigencia de D-199). O indice
-- `listings_account_item_unique` torna `(ml_account_id, item_id)` UNICO em
-- `listings`; logo a linha `l` do left join, quando existe, e a unica com
-- aquele par, e
--
--     l.sku_id = p_sku_id
--   <=>
--     (e.ml_account_id, e.entity_id) in (select ml_account_id, item_id
--                                          from listings where sku_id = p_sku_id)
--
-- Inclusive no caso do anuncio que sumiu do catalogo: ali `l` e NULL, o
-- primeiro lado da NULL (descarta) e o segundo nao encontra par (descarta).
-- Mesmo resultado -- e a linha "evento sem anuncio" que D-172 preserva de
-- proposito continua aparecendo quando NAO ha filtro de SKU.
--
-- **O que NAO foi feito, com o numero na mao.** Existe uma terceira forma,
-- sem o `or`, que entra direto por `listings_sku_idx`: **64 buffers, 0,598
-- ms** -- outros 2,7x. Ela exige derrubar o `or`, e derrubar o `or` exige ou
-- ramificar em plpgsql (duas copias da consulta para manter sincronizadas) ou
-- transformar o left join em inner, que APAGARIA a linha do anuncio que
-- sumiu. Nao vale 109 buffers hoje. Fica medida aqui para quando valer.
--
-- ------------------------------------------------------------
-- O QUE A ABA PODE E O QUE NAO PODE DIZER
-- ------------------------------------------------------------
-- `listing.price.changed` e um DIFF entre dois snapshots de 6 em 6 horas
-- (`v3-listings-snapshot`, `0 */6 * * *`, conferido em
-- `infra/cloud-scheduler.sh`; o motor e
-- `packages/domain/src/events/listing-events.ts`). Portanto:
--
--   * mudanca que sobe e volta DENTRO da mesma janela de 6h nao existe aqui;
--   * a primeira aparicao de um anuncio nao gera evento -- nao ha "antes".
--
-- Logo **ausencia de linha nao e "preco estavel"**, e a tela precisa dizer
-- isso: 95 dos 3.554 SKUs (2,7%) tem algum evento de preco, entao o estado
-- vazio e o que 97% das paginas vao mostrar -- o estado mais importante de se
-- acertar aqui, mesma disciplina do "ausencia de snapshot nao e saldo zero"
-- (D-067).
--
-- A restricao de D-172 continua valendo e fica mais dura no grao de SKU:
-- **nao ha analise antes/depois**. A serie tem 10 dias (2026-08-24 a
-- 2026-09-02) e a mediana por SKU e 1 evento (53 dos 95 SKUs tem exatamente
-- um). Afirmar impacto sobre isso seria a atribuicao causal indevida que o
-- proprio item do ROADMAP nomeia como risco.
--
-- **O vinculo e o do anuncio inteiro, e ele NAO diverge.** Medido: nos 3.168
-- anuncios com `sku_id`, `listings.sku_id` e `sku_listing_links` (linhas de
-- `variation_id is null`) concordam em 3.168 e divergem em ZERO -- nao ha dois
-- donos da verdade. O que existe sao 939 anuncios cujas VARIACOES apontam para
-- SKUs diferentes; desses, 5 tem evento de preco (de 168). Para esses 5 a
-- mudanca e do ANUNCIO, que carrega variacoes de outros SKUs -- o preco em
-- `listings` e um so por anuncio, entao esse e o grao que existe para gravar.
-- ============================================================

drop function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, integer, integer);

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
  total_count bigint
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
  )
  select
    f.event_id, f.item_id, f.title, f.status, f.sku_id, f.sku,
    f.ml_account_id, f.account_label, f.price_before, f.price_after,
    round(f.price_after - f.price_before, 2) as delta,
    round((f.price_after - f.price_before) / nullif(f.price_before, 0), 4) as delta_ratio,
    f.occurred_at,
    (select count(*) from filtrado) as total_count
  from filtrado f
  order by f.occurred_at desc, f.event_id desc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

comment on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer) is
  'Mudancas de preco observadas por anuncio (D-172, Central de Precos; p_sku_id desde D-226, para a aba Precos do SKU). delta_ratio e FRACAO (convencao de D-170), NULL se o preco anterior era zero. O filtro de SKU entra por `in` sobre os anuncios do SKU, nao por `l.sku_id = p_sku_id`: mesma resposta pela unicidade de (ml_account_id, item_id), 5,5x menos buffers com filtro e plano identico sem filtro. NAO calcula impacto antes/depois: a serie comeca em 2026-08-24 e a mediana e de 1 evento por SKU. Ausencia de linha NAO e preco estavel -- o evento e diff entre snapshots de 6 em 6 horas. security invoker.';

revoke all on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer) from public, anon;
grant execute on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, uuid, integer, integer) to authenticated, service_role;
