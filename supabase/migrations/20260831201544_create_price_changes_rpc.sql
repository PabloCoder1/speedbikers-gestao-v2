-- ============================================================
-- Central de Precos, primeira versao (D-172, trilha 5E).
--
-- As mudancas de preco JA eram registradas (`listing.price.changed`, gravado
-- por `ml-listings-fetch` a cada 6h) e nao apareciam em lugar nenhum: para
-- saber "que precos mudaram esta semana?" era preciso SQL na mao. Esta RPC e
-- a leitura desses eventos com o contexto que a tela precisa — anuncio, SKU,
-- conta, de/para, delta absoluto e proporcional.
--
-- **O que esta versao NAO faz, de proposito.** O item do ROADMAP pede
-- "analise antes/depois" e "impacto observado". A serie de eventos comeca em
-- 2026-08-24 (primeiro `listing.price.changed` observado) — sete dias. Uma
-- janela comparavel dos DOIS lados de cada mudanca nao existe ainda, e as
-- visitas por anuncio sao esporadicas (media de 4,9 dias observados em 31,
-- medido em D-170). Afirmar impacto sobre isso seria a "atribuicao causal
-- indevida" que o proprio item lista como risco. Fica para quando a serie
-- tiver janela — e o que falta e TEMPO, nao codigo.
--
-- `delta_ratio` e FRACAO (0,0728 = 7,28%), a convencao canonizada em D-170;
-- NULL quando o preco anterior e zero, nunca Infinity.
--
-- Pagina e contagem: `(select count(*) from filtrado)` como subconsulta
-- independente, o desenho que D-167 aprovou depois do EXPLAIN reprovar
-- `count(*) over ()` — aqui o volume e pequeno (71 eventos, 34,8 ms medidos
-- pelo indice `domain_events_type_idx`), mas o padrao vale desde o inicio.
--
-- `security invoker`: a RLS de `domain_events` decide o escopo por chamador.
-- ============================================================

create function public.get_price_changes(
  p_organization_id uuid,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_ml_account_id uuid default null,
  -- 'up' | 'down' | null. Valor desconhecido cai em "sem filtro" — a tela
  -- valida antes, mas a funcao nao depende disso.
  p_direction text default null,
  p_search text default null,
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
      -- O evento continua sendo verdade — a tela mostra o MLB sem titulo em
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

comment on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, integer, integer) is
  'Mudancas de preco observadas por anuncio (D-172, Central de Precos): le os eventos listing.price.changed com anuncio/SKU/conta e de-para. delta_ratio e FRACAO (convencao de D-170), NULL se o preco anterior era zero. NAO calcula impacto antes/depois: a serie comeca em 2026-08-24 e nao ha janela comparavel dos dois lados (risco de atribuicao causal indevida, nomeado no proprio item do ROADMAP). security invoker.';

revoke all on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, integer, integer) from public, anon;
grant execute on function public.get_price_changes(uuid, timestamptz, timestamptz, uuid, text, text, integer, integer) to authenticated, service_role;
