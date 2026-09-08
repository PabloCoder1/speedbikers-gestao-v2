-- ============================================================
-- `get_fulfillment_overview` ganha as CONTAGENS POR SITUACAO da faixa de
-- /full (D25, D-265).
--
-- ------------------------------------------------------------
-- AS FACETAS SAIREM DE `base` E NAO CUSTAM VARREDURA NENHUMA
-- ------------------------------------------------------------
-- `base` ja e calculada por toda chamada -- ela e o conjunto depois do recorte
-- de conta e busca, ANTES do recorte de situacao. As contagens da faixa sao um
-- `group by` sobre ela. Nenhum dos tres chamadores paga leitura nova, e nao ha
-- funcao de resumo separada (que seria segundo dono do numero, D-224, e
-- segunda ida ao banco, D-185).
--
-- ------------------------------------------------------------
-- COM LINHA-SENTINELA, e o criterio de D-264 e o que decide
-- ------------------------------------------------------------
-- A faixa do frame e NAVEGACAO: clicar num cartao filtra por aquela situacao.
-- Entao ela conta um conjunto DIFERENTE do que a tabela mostra sempre que ha
-- filtro ativo -- e e o caso de D-263, nao o de D-264.
--
-- Em `get_price_changes` (D-264) os cartoes contam o MESMO recorte da tabela,
-- entao recorte vazio tem de verdade quatro zeros e nao precisa de sentinela.
-- Aqui nao: escolher "Parado" e nao achar nada nao significa que "Ruptura"
-- tambem seja zero. Sem a sentinela, o operador perderia as contagens e o
-- caminho de volta exatamente quando mais precisa dos dois.
--
-- `facetas left join pagina on true` -- `facetas` tem sempre uma linha
-- (agregado sem `from`), entao pagina vazia devolve UMA linha com as colunas do
-- SKU em NULL. **Os tres chamadores descartam por `sku_id is null`**, e os
-- outros dois (`/skus/[skuId]` e `/anuncios/[itemId]`) foram atualizados nesta
-- mesma fatia -- mudanca de contrato nao se deixa para quem tropecar nela.
--
-- ------------------------------------------------------------
-- `count(*) over ()` CONTINUA DENTRO DO RECORTE, antes do limite
-- ------------------------------------------------------------
-- Ele so mudou de lugar: era o select final, virou a CTE `pagina`. Funcao de
-- janela roda antes de ORDER BY/LIMIT no mesmo nivel, entao `total_count`
-- segue sendo o total da BUSCA, nunca o da pagina (D-131).
--
-- ------------------------------------------------------------
-- O QUE NAO MUDOU, e o que mais importa nesta funcao
-- ------------------------------------------------------------
-- O GRAO. `ultimo_bucket` continua `distinct on (ml_account_id, inventory_id)`
-- e `as materialized`. D-173 mediu o preco de colapsar por `(sku, conta)`:
-- **15,6% de unidades a menos**. E o `as materialized` nao e enfeite -- sem
-- ele o planner reexecuta a varredura para a contagem e a funcao vai de 53 ms
-- para 899 ms.
--
-- ------------------------------------------------------------
-- ASSINATURA: os ARGUMENTOS nao mudam
-- ------------------------------------------------------------
-- So a tabela de retorno cresce. DROP + CREATE porque mudar `returns table`
-- exige, e o corpo abaixo foi EXTRAIDO do arquivo anterior, nao redigitado
-- (licao de D-259).
-- ============================================================

drop function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer);

create function public.get_fulfillment_overview(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_situation text default null,
  p_search text default null,
  p_sku_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  ml_account_id uuid,
  account_label text,
  sku_id uuid,
  sku text,
  sku_title text,
  full_quantity numeric,
  buckets integer,
  captured_at timestamptz,
  local_quantity numeric,
  units_sold bigint,
  situation text,
  total_count bigint,
  -- Contagem por situacao sobre `base` -- o conjunto ANTES do recorte de
  -- situacao. Mapa, e nao quatro colunas, pelo mesmo motivo de D-263: o
  -- vocabulario e derivado no SQL e uma situacao nova nao pode sumir da faixa
  -- sem aviso. Chave ausente e zero MEDIDO, nao desconhecido.
  facet_situation jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ultimo_bucket as materialized (
    -- O GRAO: um saldo por bucket do Mercado Livre. Colapsar por SKU aqui
    -- perderia as variacoes (246 pares tem mais de uma).
    --
    -- `as materialized` nao e enfeite: sem ele o planner reexecuta esta
    -- varredura para a contagem, e a funcao passa de 53 ms para 899 ms.
    --
    -- Ler por BUCKET tambem torna esta RPC imune a rodada pela metade: o
    -- job carimba `captured_at` uma vez no inicio e leva 5 a 6,5 minutos
    -- gravando as ~500 linhas (MEDIDO em 31/08: 312 a 395 s por rodada).
    -- Quem le `where captured_at = max(captured_at)` ve, nesses minutos,
    -- so a fracao ja gravada; aqui um bucket ainda nao regravado
    -- simplesmente mantem a captura anterior.
    select distinct on (f.ml_account_id, f.inventory_id)
           f.ml_account_id, f.sku_id, f.quantity, f.captured_at
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
      and (p_ml_account_id is null or f.ml_account_id = p_ml_account_id)
      and (p_sku_id is null or f.sku_id = p_sku_id)
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_por_sku as (
    select b.ml_account_id, b.sku_id,
           sum(b.quantity) as full_quantity,
           count(*)::integer as buckets,
           max(b.captured_at) as captured_at
    from ultimo_bucket b
    group by b.ml_account_id, b.sku_id
  ),
  vendas as (
    select m.ml_account_id, m.sku_id, sum(m.units_sold)::bigint as units_sold
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
      and m.sku_id is not null
    group by m.ml_account_id, m.sku_id
  ),
  saldo_local as (
    -- Estoque fisico e da ORGANIZACAO, nao da conta (regra do PRD). Vem
    -- junto para responder "da para repor?", e a tela mostra em coluna
    -- separada: somar com o Full seria a "soma cega" que o item veta.
    select b.sku_id, sum(b.quantity) as local_quantity
    from public.inventory_balances b
    where b.organization_id = p_organization_id and b.location_kind = 'LOCAL'
    group by b.sku_id
  ),
  base as (
    select f.ml_account_id, a.label as account_label, f.sku_id, s.sku, s.title as sku_title,
           f.full_quantity, f.buckets, f.captured_at,
           coalesce(l.local_quantity, 0) as local_quantity,
           coalesce(v.units_sold, 0)::bigint as units_sold,
           -- Criterios DETERMINISTICOS e visiveis, sem score inventado.
           case
             when f.full_quantity > 0 and coalesce(v.units_sold, 0) > 0 then 'saudavel'
             when f.full_quantity > 0 then 'parado'
             when coalesce(v.units_sold, 0) > 0 then 'ruptura'
             else 'ausente'
           end as situation
    from full_por_sku f
    join public.ml_accounts a on a.id = f.ml_account_id
    join public.skus s on s.id = f.sku_id
    left join vendas v on v.ml_account_id = f.ml_account_id and v.sku_id = f.sku_id
    left join saldo_local l on l.sku_id = f.sku_id
    where p_search is null
       or s.sku ilike '%' || p_search || '%'
       or s.title ilike '%' || p_search || '%'
  ),
  filtrado as (
    select * from base
    where p_situation is null or situation = p_situation
  )  ,
  pagina as (
    select f.*,
           -- Janela sobre o conjunto FILTRADO inteiro: funcao de janela roda
           -- antes de ORDER BY/LIMIT no mesmo nivel, entao isto continua sendo
           -- o total da busca, nao o da pagina (D-131).
           count(*) over () as total_count
    from filtrado f
    order by f.full_quantity desc, f.units_sold desc, f.sku
    limit greatest(p_limit, 0)
    offset greatest(p_offset, 0)
  ),
  facetas as (
    -- Sobre `base`: depois de conta e busca, ANTES da situacao. Se seguisse a
    -- situacao, escolher "Ruptura" zeraria "Parado" e a faixa deixaria de
    -- dizer o que existe fora do recorte -- que e a unica coisa que ela tem
    -- para dizer, sendo navegacao.
    select coalesce(jsonb_object_agg(g.situation, g.n), '{}'::jsonb) as facet_situation
    from (select b.situation, count(*)::bigint as n from base b group by b.situation) g
  )
  select p.ml_account_id, p.account_label, p.sku_id, p.sku, p.sku_title,
         p.full_quantity, p.buckets, p.captured_at, p.local_quantity, p.units_sold, p.situation,
         coalesce(p.total_count, 0)::bigint,
         x.facet_situation
  -- `facetas` ANTES, com `left join`: pagina vazia ainda devolve UMA linha,
  -- com as colunas do SKU em NULL, so para carregar as contagens da faixa.
  from facetas x
  left join pagina p on true
  order by p.full_quantity desc, p.units_sold desc, p.sku
$$;

comment on function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer) is
  'Central Full por conta e SKU (D-173; p_sku_id desde D-224; facet_situation desde D-265). O GRAO e por BUCKET (ml_account_id, inventory_id) e nao se colapsa por (sku, conta): D-173 mediu 15,6% de unidades a menos assim. `as materialized` em ultimo_bucket evita o planner reexecutar a varredura para a contagem (53 ms contra 899 ms). Le so capturas dos ultimos 3 dias -- bucket que o ML parou de reportar nao e estoque atual -- e por BUCKET a funcao fica imune a rodada pela metade do job. facet_situation conta sobre `base` (depois de conta e busca, ANTES da situacao) porque a faixa e NAVEGACAO: se seguisse o filtro, escolher "Ruptura" zeraria "Parado". Ha LINHA-SENTINELA: pagina vazia devolve uma linha com as colunas do SKU em NULL para as contagens sobreviverem -- os tres chamadores descartam por sku_id is null. Criterio da situacao e deterministico e visivel, sem score inventado. security invoker.';

revoke all on function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer) from public, anon;
grant execute on function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer) to authenticated, service_role;
