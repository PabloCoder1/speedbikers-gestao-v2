-- ============================================================
-- Somas por classe na Curva ABC (D-251, fatia D16) -- os tres cartoes do
-- frame `Abc`.
--
-- O frame desenha, por classe: valor, participacao e contagem de SKUs. A
-- contagem ja existia (`class_a_count` e irmas); o VALOR nao. Somar por classe
-- em JavaScript daria o valor da PAGINA, nao do recorte -- a classe de defeito
-- que D-131 mediu (contagem sobre amostra arbitraria de 1.000 linhas).
--
-- ------------------------------------------------------------
-- POR QUE COLUNAS, E NAO UMA RPC DE RESUMO
-- ------------------------------------------------------------
-- Em D-249 e D-250 o resumo virou RPC propria. Aqui nao, e a razao e medida:
--
--   funcao inteira (o custo que a tela ja paga)   332 ms   39.982 buffers
--   as janelas novas em cima dela                 0,2 ms
--
-- Uma segunda chamada dobraria os 332 ms para produzir tres numeros. As
-- janelas rodam sobre `filtrada` ANTES do limit -- a mesma posicao das
-- contagens que ja estavam ali --, entao falam do recorte inteiro.
--
-- ------------------------------------------------------------
-- MUDA O RETORNO, NAO OS PARAMETROS -- e por isso a conferencia importou
-- ------------------------------------------------------------
-- Trocar o `returns table` exige derrubar e recriar. As duas metades, ANTES
-- de escrever (a licao de D-237, e de novo em D-250):
--
--   catalogo   UM chamador no banco: `get_purchase_suggestions`, e ele faz
--              `select a.sku_id, a.abc_class from get_sku_abc_curve(...)` --
--              colunas NOMEADAS, imune a coluna nova. (`get_sku_curation` so
--              menciona a funcao num comentario.)
--   monorepo   `/curva-abc`, `/skus/[skuId]`, os testes e `types.ts` -- todos
--              em TypeScript, com acesso nomeado.
--
-- Nenhum consumidor le por posicao, entao acrescentar colunas no fim do
-- retorno nao quebra ninguem.
--
-- ------------------------------------------------------------
-- O QUE O FRAME PEDE E O SISTEMA NAO DA
-- ------------------------------------------------------------
-- O painel de detalhe do frame traz tres filtros rapidos: **Sem Full**, **Em
-- ruptura** e **Baixa cobertura**. So o primeiro pertence a curva --
-- `p_only_without_full` ja existe. Os outros dois nomeiam ESTADOS
-- OPERACIONAIS, que tem dono: `get_purchase_suggestions` (D-150), com a
-- politica de reposicao inteira por tras (prazo, ponto de pedido, teto) e as
-- proprias recusas.
--
-- Reimplementa-los aqui seria a segunda definicao de "ruptura" na mesma base
-- -- e a tela de reposicao e a curva discordariam no primeiro ajuste de
-- politica. Na tela eles viram LINK para `/reposicao?estado=...`, que existe
-- desde D-250. Um dado, um dono (D-224).
--
-- A barra "SKUs com risco" do frame sai pela mesma porta: "risco" nao e termo
-- definido em lugar nenhum, e inventar um limiar aqui seria constante de
-- codigo no lugar de decisao do ADMIN. No lugar dela entra "sem Full", que a
-- curva SABE e ja filtra.
-- ============================================================

drop function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text, uuid);

create function public.get_sku_abc_curve(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_criterion text default 'faturamento',
  p_only_without_full boolean default false,
  p_limit integer default 200,
  p_offset integer default 0,
  p_supplier_brand text default null,
  -- Um SKU so, DEPOIS do ranking: a classe continua sendo a da curva inteira.
  p_sku_id uuid default null
)
returns table (
  sku_id uuid, sku text, title text, metric_value numeric, metric_share numeric,
  cumulative_share numeric, abc_class text, full_quantity numeric,
  total_count bigint, class_a_count bigint, class_b_count bigint, class_c_count bigint,
  -- Somas POR CLASSE, para os tres cartoes do frame (D-251). Elas moram aqui,
  -- e nao numa RPC separada, por medicao: a janela custa 0,2 ms sobre uma
  -- funcao que ja leva 332 ms -- uma segunda chamada DOBRARIA o custo da tela
  -- para produzir tres numeros.
  class_a_value numeric, class_b_value numeric, class_c_value numeric,
  -- Quantos SKUs do recorte estao SEM Full. Pareia com `p_only_without_full`,
  -- que ja existe: a barra promete um numero e o filtro entrega a lista.
  without_full_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select m.sku_id,
      case p_criterion
        when 'unidades' then sum(m.units_sold)::numeric
        when 'pedidos'  then sum(m.orders_count)::numeric
        else sum(m.gross_revenue)
      end as metric_value
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date between p_date_from and p_date_to
      -- Escopo na PONTA 1: quais SKUs entram na curva.
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      -- Marca no MESMO lugar da conta: a curva e recalculada DENTRO da marca,
      -- nao a fatia da marca na curva global.
      and (p_supplier_brand is null
           or exists (
                select 1 from public.skus sk
                where sk.id = m.sku_id and sk.supplier_brand = p_supplier_brand))
    group by m.sku_id
    having case p_criterion
             when 'unidades' then sum(m.units_sold)::numeric
             when 'pedidos'  then sum(m.orders_count)::numeric
             else sum(m.gross_revenue)
           end > 0
  ),
  -- Escopo na PONTA 2: o denominador sai do MESMO conjunto escopado.
  total as (select sum(metric_value) as total_value from base),
  ranked as (
    select b.sku_id, b.metric_value,
      round(b.metric_value / nullif(t.total_value,0) * 100, 2) as metric_share,
      round(sum(b.metric_value) over w / nullif(t.total_value,0) * 100, 2) as cumulative_share,
      round((sum(b.metric_value) over w - b.metric_value) / nullif(t.total_value,0) * 100, 2)
        as cumulative_share_before
    from base b cross join total t
    window w as (order by b.metric_value desc, b.sku_id)
  ),
  latest_full as (
    -- GRAO CORRIGIDO em D-173: um saldo por BUCKET (`inventory_id`), nao por
    -- (sku, conta). O colapso anterior descartava as variacoes: 12 SKUs
    -- apareciam como "sem Full" tendo Full, e o total ficava 15,6% menor.
    -- Janela de frescor igual a da Central Full: saldo nao recapturado ha 3
    -- dias nao e estoque atual.
    select distinct on (f.ml_account_id, f.inventory_id) f.sku_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
      and (p_ml_account_id is null or f.ml_account_id = p_ml_account_id)
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_by_sku as (select sku_id, sum(quantity) as full_quantity from latest_full group by sku_id),
  classificada as (
    select r.sku_id, sk.sku, sk.title, r.metric_value, r.metric_share, r.cumulative_share,
      case when r.cumulative_share_before < 80 then 'A'
           when r.cumulative_share_before < 95 then 'B'
           else 'C' end as abc_class,
      coalesce(fb.full_quantity, 0) as full_quantity
    from ranked r
    join public.skus sk on sk.id = r.sku_id
    left join full_by_sku fb on fb.sku_id = r.sku_id
  ),
  filtrada as (
    select * from classificada
    where (not p_only_without_full or full_quantity = 0)
      and (p_sku_id is null or sku_id = p_sku_id)
  )
  select f.sku_id, f.sku, f.title, f.metric_value, f.metric_share, f.cumulative_share,
         f.abc_class, f.full_quantity,
         count(*) over ()                                as total_count,
         count(*) filter (where f.abc_class='A') over () as class_a_count,
         count(*) filter (where f.abc_class='B') over () as class_b_count,
         count(*) filter (where f.abc_class='C') over () as class_c_count,
         -- As janelas rodam sobre `filtrada`, ANTES do limit/offset -- entao
         -- sao do conjunto inteiro, nunca da pagina. Mesma posicao das
         -- contagens que ja estavam aqui.
         coalesce(sum(f.metric_value) filter (where f.abc_class='A') over (), 0) as class_a_value,
         coalesce(sum(f.metric_value) filter (where f.abc_class='B') over (), 0) as class_b_value,
         coalesce(sum(f.metric_value) filter (where f.abc_class='C') over (), 0) as class_c_value,
         count(*) filter (where f.full_quantity = 0) over ()                     as without_full_count
  from filtrada f
  order by f.cumulative_share, f.sku_id
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

comment on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text, uuid) is
  'Curva ABC de SKUs (D-166; marca desde D-235, p_sku_id desde D-247, somas por classe desde D-251). O escopo entra na base -- conta, marca e SKU --, entao denominador e classes sao recalculados DENTRO do recorte. As somas por classe e a contagem de "sem Full" saem de janelas sobre o conjunto filtrado, ANTES do limit: sao do recorte inteiro, nunca da pagina. security invoker.';

revoke all on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text, uuid) from public, anon;
grant execute on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text, uuid) to authenticated, service_role;
