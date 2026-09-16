-- ============================================================
-- D-361 — quanto do catalogo cada regra de reposicao alcanca.
--
-- A tela de configuracao (`/reposicao/configuracoes`) listava as regras e
-- nao dizia o que elas FAZEM. Em producao, no dia desta fatia, havia zero
-- regras para 3.240 SKUs de 17 marcas -- a sugestao de compra recusava o
-- catalogo inteiro, e a tela que conserta isso nao mostrava nem a marca, nem
-- quantos SKUs cada escolha destrava.
--
-- Esta leitura devolve, por MARCA do fornecedor (o eixo de D-129), as
-- contagens que a tela precisa para responder "se eu configurar isto, quanto
-- do catalogo passa a ter sugestao?". A precedencia das regras (SKU > marca >
-- padrao, D-144) continua sendo aplicada em UM lugar so -- a peca pura
-- `resolveReplenishmentPolicy` e a sua copia SQL em `get_purchase_suggestions`.
-- Aqui so se CONTA; quem cruza contagem com regra e a tela, por uma funcao
-- testada (`lib/replenishment-reach.ts`), sobre as regras que ela ja le.
--
-- ## O universo e o MESMO de `get_purchase_suggestions`
--
-- A reposicao nao lista os 3.240 SKUs do cadastro: lista os que tem saldo em
-- `inventory_balances` (qualquer local) OU linha em `daily_sku_metrics` nos
-- ultimos 90 dias (a CTE `combined`, via full outer join, com `skus` em inner
-- join). `skus_na_reposicao` usa exatamente essa regra, para que "a regra da
-- marca X alcanca N SKUs" seja o mesmo N que `/reposicao?marca=X` mostra.
-- Contar o cadastro inteiro prometeria SKUs que a reposicao nunca exibe.
--
-- `skus` (o cadastro) sai junto para a tela poder dizer "N no cadastro, M na
-- reposicao" sem uma segunda ida, e para uma marca sem nenhum SKU na
-- reposicao continuar aparecendo como opcao de regra.
--
-- `skus_com_venda_30d` e o subconjunto com venda na janela da TAXA (30 dias,
-- `units_30d`): so eles podem receber estado -- sem venda recente a
-- cobertura e indefinida (SEM_DEMANDA_RECENTE, D-148). E o numero que diz
-- quanto uma regra muda A TELA DE REPOSICAO HOJE.
--
-- `skus_com_regra_sku` conta os SKUs do grupo, DENTRO do universo, com regra
-- PROPRIA; `skus_com_regra_sku_venda_30d`, os que dentre eles venderam. Eles
-- ficam cobertos mesmo quando a marca nao tem regra nem ha padrao, e sem
-- esses dois numeros a porcentagem de cobertura da tela seria aproximada --
-- contar no cadastro inteiro incluiria SKU com regra que a reposicao nem
-- lista.
--
-- Marca NULA e um grupo legitimo (D-129): SKU sem marca so pode usar o
-- padrao da organizacao, e a tela precisa saber quantos sao.
--
-- ## Custo
--
-- As mesmas duas varreduras que `get_purchase_suggestions` ja faz (saldos e
-- 90 dias de metricas, pelos indices de organizacao), sem Full, ABC,
-- historico nem classificacao -- nada disso muda o que uma regra alcanca.
-- `language sql`, sem plano generico a evitar: nao ha parametro de filtro
-- que mude a forma do plano.
--
-- security invoker: a RLS de `skus`, `inventory_balances`,
-- `daily_sku_metrics` e `replenishment_settings` ja restringe a organizacao
-- do chamador. O parametro serve ao indice, nao a autorizacao (o mesmo
-- raciocinio de `get_supplier_brands`).
-- ============================================================

create function public.get_replenishment_reach(
  p_organization_id uuid,
  -- Nulo = hoje, como em `get_purchase_suggestions` (D-280): zero nunca e a
  -- resposta para "voce nao me disse a data".
  p_date_to date default null
)
returns table (
  supplier_brand text,
  skus bigint,
  skus_na_reposicao bigint,
  skus_com_venda_30d bigint,
  skus_com_regra_sku bigint,
  skus_com_regra_sku_venda_30d bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with janela as (
    select coalesce(p_date_to, current_date) as ate
  ),
  com_saldo as (
    select distinct b.sku_id
    from public.inventory_balances b
    where b.organization_id = p_organization_id
  ),
  vendas as (
    -- As mesmas bordas de `trend_windows` em `get_purchase_suggestions`.
    select m.sku_id,
      coalesce(sum(m.units_sold) filter (where m.metric_date > (select ate from janela) - 30), 0) as units_30d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date > (select ate from janela) - 90
      and m.metric_date <= (select ate from janela)
    group by m.sku_id
  ),
  universo as (
    select coalesce(s.sku_id, v.sku_id) as sku_id, coalesce(v.units_30d, 0) as units_30d
    from com_saldo s
    full outer join vendas v on v.sku_id = s.sku_id
  ),
  regra_sku as (
    select r.sku_id
    from public.replenishment_settings r
    where r.organization_id = p_organization_id
      and r.sku_id is not null
  )
  select
    sk.supplier_brand,
    count(*)::bigint as skus,
    count(u.sku_id)::bigint as skus_na_reposicao,
    count(u.sku_id) filter (where u.units_30d > 0)::bigint as skus_com_venda_30d,
    count(rs.sku_id) filter (where u.sku_id is not null)::bigint as skus_com_regra_sku,
    count(rs.sku_id) filter (where u.units_30d > 0)::bigint as skus_com_regra_sku_venda_30d
  from public.skus sk
  left join universo u on u.sku_id = sk.id
  left join regra_sku rs on rs.sku_id = sk.id
  where sk.organization_id = p_organization_id
  group by sk.supplier_brand
  order by sk.supplier_brand nulls first;
$$;

comment on function public.get_replenishment_reach(uuid, date) is
  'D-361: por marca do fornecedor (nula inclusive), quantos SKUs ha no cadastro, quantos estao no universo da reposicao (saldo ou metrica nos ultimos 90 dias, o mesmo de get_purchase_suggestions), quantos venderam nos ultimos 30 dias e, dentro do universo, quantos tem regra propria por SKU (e quantos destes venderam). So conta: a precedencia SKU > marca > padrao fica na tela, sobre as regras lidas. security invoker.';

revoke all on function public.get_replenishment_reach(uuid, date) from public, anon;
grant execute on function public.get_replenishment_reach(uuid, date) to authenticated, service_role;
