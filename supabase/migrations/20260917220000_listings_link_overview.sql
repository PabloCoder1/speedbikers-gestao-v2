-- ============================================================
-- D-376 — get_listings_link_overview: a pagina de /vinculacoes numa leitura so
-- ============================================================
--
-- O QUE ESTAVA CARO -- medido em PRODUCAO como `authenticated`, org com 4.447
-- anuncios. (A primeira versao deste comentario dizia "Dev": eu media no projeto
-- errado. Os numeros sao os mesmos, a etiqueta e que estava trocada -- e etiqueta
-- trocada em medicao e a semente de conclusao errada, entao fica registrado.)
--
--   a lista (50 sem vinculo)  get_listings_dashboard      180,5 ms
--   as 4 contagens da faixa   get_listings_dashboard x4   531,5 ms
--   comparacao entre contas   get_link_integrity        1.305,8 ms
--
-- Sao 712 ms de banco so no bloco principal, porque cada celula da faixa
-- repetia a MESMA funcao pesada com `p_limit => 1` (o padrao de D-242, correto
-- quando a funcao e barata). `get_listings_dashboard` monta metricas, visitas
-- e o ultimo snapshot de Full a cada chamada -- cinco vezes por carregamento.
--
-- Esta funcao faz esse trabalho UMA vez e devolve pagina + contagens + uma
-- linha por conta. Medido igual, mesma org: **91,4 ms a frio e 78,3 ms
-- quente**. As contagens conferem com as de hoje sem diferenca nenhuma
-- (4.447 / 3.976 / 471 / 231), e as colunas de catalogo por conta conferem com
-- `get_link_integrity` linha a linha (1.065/948/117/89,0 ...).
--
-- O QUE ELA NAO FAZ, DE PROPOSITO:
--
-- - **visitas e conversao**: /vinculacoes nao mostra nenhuma das duas, e o join
--   com `daily_listing_visits` era parte do custo. Quem precisa delas continua
--   em `get_listings_dashboard` (/anuncios).
-- - **a fonte independente de venda**: `get_link_integrity` conta venda a
--   partir de `order_items`, um caminho que NAO passa pelo pipeline de
--   metricas, e e por isso que a tela mostra as duas (D-128). Aqui a venda vem
--   de `daily_listing_metrics`, igual a tabela. A comparacao continua chamando
--   `get_link_integrity` para a coluna independente -- so que agora depois, e
--   sem segurar o resto da pagina.
--
-- Funcao NOVA e so de leitura. Nenhuma funcao de vinculo foi tocada: o
-- combinado com a sessao da D-362 e que funcoes de vinculo, worker e
-- importacao sao dela.
--
-- `plan_cache_mode = 'force_custom_plan'` pela licao de D-305: em plano
-- generico o planejador erra as estimativas destas CTEs por ordens de grandeza
-- e troca hash join por nested loop.
-- ============================================================

create or replace function public.get_listings_link_overview(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  -- 'all' | 'linked' | 'unlinked' -- o MESMO vocabulario de
  -- get_listings_dashboard, para a traducao da web continuar num lugar so
  -- (`toRpcArgs`, lib/link-integrity-filters.ts).
  p_link_state text default 'all',
  -- 'all' | 'with' | 'without' -- houve venda na janela (D-259).
  p_sold text default 'all',
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  v_resultado jsonb;
begin
  with metricas as (
    -- Venda na janela, por anuncio. Ausencia de metrica E ausencia de venda
    -- (diferente do Full, onde ausencia de snapshot nao e estoque zero, D-067).
    select m.ml_account_id,
           m.mlb_id,
           sum(m.units_sold)::bigint as units_sold,
           sum(m.gross_revenue)      as gross_revenue
    from public.daily_listing_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
    group by m.ml_account_id, m.mlb_id
  ),
  vinculos as (
    -- Vinculo POR VARIACAO: o anuncio tem link mas `listings.sku_id` e nulo.
    -- D-122 mediu que tratar nulo como "sem vinculo" DOBRARIA o numero.
    select distinct k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
  ),
  full_ultimo as (
    -- A definicao canonica de Full (D-173/D-204): o ultimo snapshot por
    -- (conta, inventory_id), so dos ultimos 3 dias.
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
  candidatos as (
    select c.ml_account_id, count(*) as abertos
    from public.link_candidates c
    where c.organization_id = p_organization_id
      and c.status = 'OPEN'
    group by c.ml_account_id
  ),
  base as (
    -- TODOS os anuncios da organizacao, sem o recorte de conta nem a busca: e
    -- desta CTE que sai a comparacao entre contas, que ignora o filtro de
    -- conta de proposito -- comparar e o servico dela (D-128).
    select l.id                 as listing_id,
           l.item_id,
           l.title,
           l.price,
           l.ml_account_id,
           a.label              as account_label,
           a.slug               as account_slug,
           l.sku_id,
           s.sku,
           case when l.sku_id is not null   then 'linked'
                when kv.item_id is not null then 'linked_variation'
                else 'unlinked' end as link_state,
           coalesce(md.units_sold, 0)::bigint as units_sold,
           coalesce(md.gross_revenue, 0)      as gross_revenue,
           -- NULA sem snapshot: ausencia de dado nao e zero (D-067).
           fa.full_quantity
    from public.listings l
    join public.ml_accounts a on a.id = l.ml_account_id
    left join public.skus s on s.id = l.sku_id
    left join metricas md on md.ml_account_id = l.ml_account_id and md.mlb_id = l.item_id
    left join vinculos kv on kv.ml_account_id = l.ml_account_id and kv.item_id = l.item_id
    left join full_por_anuncio fa on fa.ml_account_id = l.ml_account_id and fa.item_id = l.item_id
    where l.organization_id = p_organization_id
  ),
  por_conta as (
    /*
      Sai de `ml_accounts`, nao de `base`: agrupar os anuncios faria a conta
      recem-conectada, ainda sem anuncio sincronizado, DESAPARECER da
      comparacao — e "nao aparece" se le como "nao existe", quando o certo e
      "ainda nao tem anuncio". Ela entra com zeros e percentual NULO.
    */
    select a.id                                                     as ml_account_id,
           a.label                                                  as account_label,
           a.slug                                                   as account_slug,
           count(b.listing_id)                                      as listings_total,
           count(*) filter (where b.link_state <> 'unlinked')       as com_vinculo,
           count(*) filter (where b.link_state = 'unlinked')        as sem_vinculo,
           -- Sem anuncio nenhum NAO ha percentual: "0%" afirmaria que nenhum
           -- esta vinculado. Nulo aqui quer dizer "nao se aplica" (D-254).
           round(100.0 * count(*) filter (where b.link_state <> 'unlinked')
                 / nullif(count(b.listing_id), 0), 1)                as pct_vinculado,
           count(*) filter (where b.link_state = 'unlinked' and b.units_sold > 0) as vendidos_sem_vinculo,
           coalesce(sum(b.gross_revenue) filter (where b.link_state = 'unlinked'), 0) as receita_sem_vinculo,
           coalesce((select k.abertos from candidatos k where k.ml_account_id = a.id), 0) as candidatos_abertos
    from public.ml_accounts a
    left join base b on b.ml_account_id = a.id
    where a.organization_id = p_organization_id
    group by a.id, a.label, a.slug
  ),
  recorte as (
    -- A JANELA declarada da tela: conta escolhida e busca. As contagens dos
    -- cartoes saem DAQUI, para que clicar num cartao mostre as linhas que ele
    -- promete (D-242) -- inclusive com a busca ativa.
    select * from base b
    where (p_ml_account_id is null or b.ml_account_id = p_ml_account_id)
      and (p_search is null
           or b.item_id ilike '%' || p_search || '%'
           or b.title   ilike '%' || p_search || '%'
           or b.sku     ilike '%' || p_search || '%')
  ),
  contagens as (
    select count(*)                                                  as todos,
           count(*) filter (where r.link_state <> 'unlinked')         as vinculados,
           count(*) filter (where r.link_state = 'linked_variation')  as por_variacao,
           count(*) filter (where r.link_state = 'unlinked')          as sem_vinculo,
           count(*) filter (where r.link_state = 'unlinked' and r.units_sold > 0) as vendidos_sem_vinculo,
           count(*) filter (where r.link_state = 'unlinked' and r.units_sold = 0) as parados_sem_vinculo,
           -- Zero legitimo: sem anuncio sem vinculo NAO ha receita em risco.
           coalesce(sum(r.gross_revenue) filter (where r.link_state = 'unlinked'), 0) as receita_sem_vinculo,
           coalesce(sum(r.units_sold)    filter (where r.link_state = 'unlinked'), 0) as unidades_sem_vinculo,
           -- A fila do ERP nao tem titulo nem MLB para a busca casar, entao ela
           -- segue a conta escolhida e IGNORA `p_search` -- e o cartao dela diz
           -- isso na tela quando ha busca ativa.
           (select coalesce(sum(k.abertos), 0)
            from candidatos k
            where p_ml_account_id is null or k.ml_account_id = p_ml_account_id) as candidatos_abertos
    from recorte r
  ),
  filtrado as (
    select * from recorte r
    where case p_link_state
            when 'linked'   then r.link_state <> 'unlinked'
            when 'unlinked' then r.link_state = 'unlinked'
            else true
          end
      and case p_sold
            when 'with'    then r.units_sold > 0
            when 'without' then r.units_sold = 0
            else true
          end
  ),
  pagina as (
    -- Pela receita da janela: o anuncio sem vinculo que mais fatura e o que
    -- mais custa caro deixar sem vinculo, e aparece primeiro.
    select f.*, count(*) over () as total_count
    from filtrado f
    order by f.gross_revenue desc, f.title asc, f.item_id asc
    limit greatest(p_limit, 0)
    offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total',     coalesce((select max(p.total_count) from pagina p), 0),
    'contagens', (select to_jsonb(c) from contagens c),
    'por_conta', coalesce((select jsonb_agg(to_jsonb(q) order by q.account_label) from por_conta q), '[]'::jsonb),
    'linhas',    coalesce((select jsonb_agg(to_jsonb(p) - 'total_count'
                                            order by p.gross_revenue desc, p.title asc, p.item_id asc)
                           from pagina p), '[]'::jsonb)
  )
  into v_resultado;

  return v_resultado;
end;
$fn$;

comment on function public.get_listings_link_overview(uuid, date, date, uuid, text, text, text, integer, integer) is
  'D-376: a pagina de /vinculacoes numa leitura so -- pagina + contagens dos cartoes + uma linha por conta. Substitui as CINCO chamadas a get_listings_dashboard que a tela fazia (uma lista + quatro contagens com p_limit => 1) e as colunas de CATALOGO de get_link_integrity. Producao, authenticated, 4.447 anuncios: 91,4 ms a frio e 78,3 ms quente, contra 712 ms das cinco chamadas; as contagens e as colunas por conta conferem com as de hoje sem diferenca. NAO traz visitas nem conversao (a tela nao mostra) e NAO traz a fonte independente de venda: essa continua em get_link_integrity, a partir de order_items, e a tela declara a divergencia (D-128). por_conta ignora o filtro de conta e a busca de proposito. link_state tem TRES valores (D-122). security invoker, force_custom_plan (D-305).';

revoke all on function public.get_listings_link_overview(uuid, date, date, uuid, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_listings_link_overview(uuid, date, date, uuid, text, text, text, integer, integer) to authenticated, service_role;
