-- D-410 — A margem mínima dos produtos e o piso do ROAS contra a meta viram
-- limites da organização (continua D-408).
--
-- Os dois cortes de negócio que ainda moravam no SQL:
--
--   margem mínima (10%)   get_faturamento: a lista "menor margem" e a
--                         contagem de produtos abaixo dela; a web pinta de
--                         atenção a margem abaixo do mesmo corte
--   piso do ROAS (80%)    get_sinais_ads: campanha com ROAS abaixo de 80% da
--                         meta dela é "abaixo da meta" -- também o alerta
--                         gravado por sincronizar_alertas_central (D-403)
--
-- Nenhuma assinatura muda: as funções leem `central_thresholds` e devolvem o
-- número que usaram (`margem_minima`, `referencias.roas_piso`), para a tela
-- dizer o mesmo corte que a conta usou. A web vai ao ar antes desta
-- migration; sem a chave, ela usa os mesmos 10% e 80%.
--
-- `get_faturamento` não recebe a organização: a margem é a da organização de
-- quem chama (`organization_members` de `auth.uid()`). Quem chama sem usuário
-- -- o service_role -- fica com os 10%. `get_sinais_ads` recebe a organização.
--
-- As pontuações internas do detector de frete ficam no código: são a
-- calibragem do detector (D-397/D-399), não um limite de negócio.

alter table public.central_thresholds
  add column margin_floor numeric(6,4) not null default 0.10,
  add column ads_roas_floor numeric(6,4) not null default 0.80,
  add constraint central_thresholds_margin_floor_check check (margin_floor > 0 and margin_floor < 1),
  add constraint central_thresholds_ads_roas_floor_check check (ads_roas_floor > 0 and ads_roas_floor <= 1);

comment on column public.central_thresholds.margin_floor is
  'Margem mínima dos produtos (D-410): abaixo dela o produto entra na lista de menor margem e a margem pede atenção. Fração; padrão 0,10.';
comment on column public.central_thresholds.ads_roas_floor is
  'Piso do ROAS contra a meta da campanha (D-410): abaixo desta fração da meta, a campanha está abaixo da meta. Padrão 0,80.';

create or replace function public.get_faturamento(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_detalhe boolean default true
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  -- D-410: a margem mínima da organização de quem chama (central_thresholds);
  -- sem linha -- ou sem usuário, como o service_role --, os 10% de sempre.
  v_margem_minima numeric := coalesce((
    select t.margin_floor
    from public.central_thresholds t
    where t.organization_id in (
      select m.organization_id
      from public.organization_members m
      where m.user_id = (select auth.uid())
    )
    order by t.organization_id
    limit 1
  ), 0.10);
begin
  return (
  with bounds as (
    select (p_date_from::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to
  ),
  pedidos as materialized (
    select o.id, o.organization_id, o.ml_account_id, o.pack_id, o.date_created
    from public.orders o
    cross join bounds b
    where o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and o.status in ('paid', 'partially_refunded')
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
  ),
  linhas as materialized (
    select
      p.id as order_id,
      p.organization_id,
      p.ml_account_id,
      p.date_created,
      p.pack_id,
      oi.id as item_id,
      oi.sku_id,
      oi.quantity,
      oi.quantity * oi.unit_price as receita,
      oi.sale_fee * oi.quantity as comissao
    from pedidos p
    -- Uma busca por pedido no indice (order_id, position). O `offset 0`
    -- impede a subconsulta de virar join comum: sem ele, o plano custom
    -- varre order_items inteira em hash join (cabecalho, item 3).
    cross join lateral (
      select i.id, i.sku_id, i.quantity, i.unit_price, i.sale_fee
      from public.order_items i
      where i.order_id = p.id
        and i.organization_id = p.organization_id
        and i.ml_account_id = p.ml_account_id
      offset 0
    ) oi
  ),
  skus_janela as materialized (
    select distinct l.sku_id
    from linhas l
    where l.sku_id is not null
  ),
  componentes as materialized (
    select sc.kit_sku_id, sc.component_sku_id, sc.quantity
    from public.sku_components sc
    where sc.kit_sku_id in (select j.sku_id from skus_janela j)
  ),
  -- Cada mudanca de custo vira o intervalo [desde, ate): o item acha o seu
  -- por hash em sku_id + o filtro do intervalo, que e o "ultimo new_cost com
  -- changed_at <= date_created" de D-356. Empate de changed_at: vence o
  -- maior id (o intervalo vazio [t, t) nunca casa).
  --
  -- So ficam os intervalos que CRUZAM a janela (item 6 do cabecalho): o
  -- `lead()` corre sobre o historico inteiro do SKU, e o filtro vem depois,
  -- por fora -- nao desce para dentro da janela de `lead()`, porque `desde`
  -- e `ate` nao sao a particao. As datas sao as de `bounds` repetidas, e nao
  -- uma segunda referencia a `bounds`: CTE citada duas vezes e materializada,
  -- e `pedidos` deixaria de ver as datas como constantes no plano.
  historico as materialized (
    select t.sku_id, t.desde, t.ate, t.new_cost
    from (
      select
        h.sku_id,
        h.changed_at as desde,
        lead(h.changed_at) over (partition by h.sku_id order by h.changed_at, h.id) as ate,
        h.new_cost
      from public.sku_cost_history h
      where h.sku_id in (
        select j.sku_id from skus_janela j
        union
        select c.component_sku_id from componentes c
      )
    ) t
    where t.desde < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
      and (t.ate is null or t.ate > (p_date_from::timestamp at time zone 'America/Sao_Paulo'))
  ),
  custo_kit as materialized (
    select
      l.item_id,
      count(*) as componentes,
      case when count(*) > 0 and bool_and(v.custo_unitario is not null)
           then sum(v.custo_unitario * c.quantity) end as custo,
      case when bool_and(v.fonte = 'historico') then 'historico' else 'atual' end as fonte
    from linhas l
    join componentes c on c.kit_sku_id = l.sku_id
    join public.skus cs on cs.id = c.component_sku_id
    left join historico hc
      on hc.sku_id = cs.id
     and hc.desde <= l.date_created
     and (hc.ate is null or l.date_created < hc.ate)
    cross join lateral (
      select
        nullif(coalesce(hc.new_cost, cs.purchase_cost), 0) as custo_unitario,
        case
          when coalesce(hc.new_cost, 0) > 0 then 'historico'
          when coalesce(cs.purchase_cost, 0) > 0 then 'atual'
        end as fonte
    ) v
    group by l.item_id
  ),
  custo as (
    select
      l.item_id,
      case
        when s.kind = 'KIT' and k.componentes > 0 then k.custo
        else nullif(coalesce(hs.new_cost, s.purchase_cost), 0)
      end * l.quantity as custo,
      case
        when s.kind = 'KIT' and k.componentes > 0 then k.fonte
        when coalesce(hs.new_cost, 0) > 0 then 'historico'
        when coalesce(s.purchase_cost, 0) > 0 then 'atual'
      end as fonte
    from linhas l
    join public.skus s on s.id = l.sku_id
    left join historico hs
      on hs.sku_id = s.id
     and hs.desde <= l.date_created
     and (hs.ate is null or l.date_created < hs.ate)
    left join custo_kit k on k.item_id = l.item_id
  ),
  -- O pedido e agregado ANTES do frete: `itens` e o count(*) do grupo, e o
  -- frete e o desconto entram uma vez por pedido em `classificado` -- os
  -- mesmos valores que o row_number() = 1 + max() de D-356 davam.
  por_pedido as (
    select
      l.order_id,
      l.organization_id,
      l.ml_account_id,
      (l.date_created at time zone 'America/Sao_Paulo')::date as dia,
      case when l.pack_id is null then 'order:' || l.order_id::text else 'pack:' || l.pack_id::text end as compra,
      sum(l.receita) as receita,
      sum(l.quantity) as unidades,
      sum(l.comissao) as comissao,
      bool_and(l.comissao is not null) as comissao_ok,
      count(*) as itens,
      sum(c.custo) as custo,
      bool_and(c.custo is not null) as custo_ok,
      bool_or(c.fonte = 'atual') as custo_atual,
      bool_or(l.sku_id is null) as sem_sku
    from linhas l
    left join custo c on c.item_id = l.item_id
    group by l.order_id, l.organization_id, l.ml_account_id, l.date_created, l.pack_id
  ),
  -- D-395: a aliquota de imposto vigente em cada dia, em intervalos
  -- [desde, ate) por organizacao. A tabela e minuscula (uma linha por mudanca
  -- de aliquota), e o pedido acha a sua pelo dia de negocio -- o mesmo dia
  -- das demais metricas. Sem aliquota cadastrada para o dia, o imposto do
  -- pedido e NULL, e os totais que dependem dele tambem.
  aliquotas as (
    select
      t.organization_id,
      t.valid_from as desde,
      lead(t.valid_from) over (partition by t.organization_id order by t.valid_from) as ate,
      t.rate
    from public.tax_rates t
  ),
  classificado as materialized (
    select
      p.order_id,
      p.ml_account_id,
      p.dia,
      p.compra,
      p.receita,
      p.unidades,
      p.comissao,
      p.comissao_ok,
      f.seller_shipping_cost as frete,
      f.seller_discount as desconto,
      p.itens,
      p.custo,
      p.custo_ok,
      p.custo_atual,
      p.sem_sku,
      a.rate as aliquota,
      p.receita * a.rate as imposto,
      (f.seller_shipping_cost is not null and p.comissao_ok) as com_custos,
      (f.seller_shipping_cost is not null and p.comissao_ok and p.custo_ok and p.itens = 1) as coberto
    from por_pedido p
    left join public.order_financials f on f.order_id = p.order_id
    left join aliquotas a
      on a.organization_id = p.organization_id
     and p.dia >= a.desde
     and (a.ate is null or p.dia < a.ate)
  ),
  resumo as (
    select jsonb_build_object(
      'pedidos', count(*),
      'compras', count(distinct k.compra),
      'unidades', coalesce(sum(k.unidades), 0),
      'receita_bruta', coalesce(round(sum(k.receita), 2), 0),
      'taxas_ml', coalesce(round(sum(k.comissao), 2), 0),
      'ticket_medio', round(sum(k.receita) / nullif(count(distinct k.compra), 0), 2),
      'preco_medio', round(sum(k.receita) / nullif(sum(k.unidades), 0), 2),
      'comissao_percentual', round(sum(k.comissao) / nullif(sum(k.receita), 0), 4),
      'pedidos_com_custos', count(*) filter (where k.com_custos),
      'receita_com_custos', round(sum(k.receita) filter (where k.com_custos), 2),
      'taxas_ml_com_custos', round(sum(k.comissao) filter (where k.com_custos), 2),
      'frete_vendedor', round(sum(k.frete) filter (where k.com_custos), 2),
      'desconto_vendedor', round(sum(k.desconto) filter (where k.com_custos), 2),
      'margem_operacional', round(sum(k.receita - k.comissao - k.frete) filter (where k.com_custos), 2),
      'frete_medio_pedido', round(sum(k.frete) filter (where k.com_custos) / nullif(count(*) filter (where k.com_custos), 0), 2),
      'pedidos_cobertos', count(*) filter (where k.coberto),
      'receita_coberta', round(sum(k.receita) filter (where k.coberto), 2),
      -- Os degraus da cascata, do MESMO subconjunto coberto: a tela nao soma.
      'taxas_ml_cobertas', round(sum(k.comissao) filter (where k.coberto), 2),
      'frete_vendedor_coberto', round(sum(k.frete) filter (where k.coberto), 2),
      'margem_operacional_coberta', round(sum(k.receita - k.comissao - k.frete) filter (where k.coberto), 2),
      'custo_produtos', round(sum(k.custo) filter (where k.coberto), 2),
      'resultado_venda', round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto), 2),
      'margem_venda', round(
        sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto)
        / nullif(sum(k.receita) filter (where k.coberto), 0), 4),
      'pedidos_custo_atual', count(*) filter (where k.coberto and k.custo_atual),
      'pedidos_sem_sku', count(*) filter (where k.sem_sku),
      'pedidos_sem_custo', count(*) filter (where not k.sem_sku and not k.custo_ok),
      'pedidos_sem_frete', count(*) filter (where not k.com_custos),
      'pedidos_multi_item', count(*) filter (where k.itens > 1),
      -- D-395: imposto pela aliquota vigente no dia de cada pedido. So existe
      -- quando TODOS os pedidos do conjunto tem aliquota: somar os que tem e
      -- ignorar os que nao tem daria um imposto menor com cara de exato.
      'pedidos_sem_aliquota', count(*) filter (where k.aliquota is null),
      'aliquota_unica', case
        when count(*) > 0 and bool_and(k.aliquota is not null) and count(distinct k.aliquota) = 1
        then max(k.aliquota) end,
      'imposto_estimado', case
        when count(*) > 0 and bool_and(k.aliquota is not null)
        then round(sum(k.imposto), 2) end,
      'imposto_coberto', case
        when count(*) filter (where k.coberto) > 0 and bool_and(k.aliquota is not null) filter (where k.coberto)
        then round(sum(k.imposto) filter (where k.coberto), 2) end,
      'resultado_apos_imposto', case
        when count(*) filter (where k.coberto) > 0 and bool_and(k.aliquota is not null) filter (where k.coberto)
        then round(sum(k.receita - k.comissao - k.frete - k.custo - k.imposto) filter (where k.coberto), 2) end,
      'margem_apos_imposto', case
        when count(*) filter (where k.coberto) > 0 and bool_and(k.aliquota is not null) filter (where k.coberto)
        then round(
          sum(k.receita - k.comissao - k.frete - k.custo - k.imposto) filter (where k.coberto)
          / nullif(sum(k.receita) filter (where k.coberto), 0), 4) end
    ) as j
    from classificado k
  ),
  diario as (
    select coalesce(jsonb_agg(to_jsonb(d) order by d.dia), '[]'::jsonb) as j
    from (
      select
        k.dia,
        count(*) as pedidos,
        round(sum(k.receita), 2) as receita_bruta,
        round(sum(k.comissao), 2) as taxas_ml,
        round(sum(k.frete) filter (where k.com_custos), 2) as frete_vendedor,
        round(sum(k.receita) filter (where k.coberto), 2) as receita_coberta,
        round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto), 2) as resultado_venda,
        round(
          sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto)
          / nullif(sum(k.receita) filter (where k.coberto), 0), 4) as margem_venda
      from classificado k
      where p_detalhe
      group by k.dia
    ) d
  ),
  por_conta as (
    select coalesce(jsonb_agg(to_jsonb(c) order by c.receita_bruta desc, c.ml_account_id), '[]'::jsonb) as j
    from (
      select
        k.ml_account_id,
        a.label as conta,
        count(*) as pedidos,
        round(sum(k.receita), 2) as receita_bruta,
        round(sum(k.comissao), 2) as taxas_ml,
        count(*) filter (where k.com_custos) as pedidos_com_custos,
        round(sum(k.frete) filter (where k.com_custos), 2) as frete_vendedor,
        round(sum(k.receita - k.comissao - k.frete) filter (where k.com_custos), 2) as margem_operacional,
        count(*) filter (where k.coberto) as pedidos_cobertos,
        round(sum(k.receita) filter (where k.coberto), 2) as receita_coberta,
        round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto), 2) as resultado_venda,
        round(
          sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto)
          / nullif(sum(k.receita) filter (where k.coberto), 0), 4) as margem_venda
      from classificado k
      join public.ml_accounts a on a.id = k.ml_account_id
      where p_detalhe
      group by k.ml_account_id, a.label
    ) c
  ),
  por_sku_base as materialized (
    select
      l.sku_id,
      sum(l.quantity) as unidades,
      count(distinct l.order_id) as pedidos,
      round(sum(l.receita), 2) as receita_bruta,
      round(sum(l.comissao), 2) as taxas_ml,
      count(*) filter (where k.coberto) as pedidos_cobertos,
      round(sum(l.receita) filter (where k.coberto), 2) as receita_coberta,
      round(sum(k.frete) filter (where k.coberto), 2) as frete_vendedor,
      round(sum(k.custo) filter (where k.coberto), 2) as custo_produtos,
      round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto), 2) as resultado_venda,
      round(
        sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto)
        / nullif(sum(l.receita) filter (where k.coberto), 0), 4) as margem_venda,
      coalesce(bool_or(k.custo_atual) filter (where k.coberto), false) as custo_atual
    from linhas l
    join classificado k on k.order_id = l.order_id
    where p_detalhe
      and l.sku_id is not null
    group by l.sku_id
  ),
  por_sku as (
    select jsonb_build_object(
      'maior_receita', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.receita_bruta desc, x.sku_id), '[]'::jsonb)
        from (
          select b.*, s.sku, s.title
          from por_sku_base b
          join public.skus s on s.id = b.sku_id
          order by b.receita_bruta desc, b.sku_id
          limit 30
        ) x
      ),
      'menor_margem', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.margem_venda, x.receita_coberta desc, x.sku_id), '[]'::jsonb)
        from (
          select b.*, s.sku, s.title
          from por_sku_base b
          join public.skus s on s.id = b.sku_id
          where b.pedidos_cobertos > 0
            and b.margem_venda < v_margem_minima
          order by b.margem_venda, b.receita_coberta desc, b.sku_id
          limit 20
        ) x
      ),
      'skus_com_venda', (select count(*) from por_sku_base),
      -- O nome da chave ficou do tempo em que o corte era fixo; o corte é `margem_minima`.
      'skus_margem_abaixo_10', (select count(*) from por_sku_base where pedidos_cobertos > 0 and margem_venda < v_margem_minima),
      'skus_margem_negativa', (select count(*) from por_sku_base where pedidos_cobertos > 0 and margem_venda < 0)
    ) as j
  )
  select jsonb_build_object(
    'resumo', r.j,
    'margem_minima', v_margem_minima,
    'diario', case when p_detalhe then d.j end,
    'por_conta', case when p_detalhe then c.j end,
    'por_sku', case when p_detalhe then s.j end
  )
  from resumo r, diario d, por_conta c, por_sku s
  );
end;
$$;

create or replace function public.get_sinais_ads(
  p_organization_id uuid,
  p_hoje date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  v_hoje date := coalesce(p_hoje, (now() at time zone 'America/Sao_Paulo')::date);
  v_fim date;
  v_pendentes jsonb;
  -- D-410: abaixo de que fração da meta de ROAS da campanha ela está "abaixo
  -- da meta", pela organização (central_thresholds); sem linha, os 80% de sempre.
  v_roas_piso numeric := coalesce((
    select t.ads_roas_floor from public.central_thresholds t where t.organization_id = p_organization_id
  ), 0.80);
begin
  -- O último dia consolidado da empresa (D-401): gravado por um sync DEPOIS de
  -- o dia acabar, com venda atribuída e impressão. Os dias com gasto depois
  -- dele são os pendentes -- inclusive o retrato parcial do dia do sync.
  with recentes as (
    select
      m.metric_date,
      sum(m.cost) as custo,
      sum(m.total_amount) as vendas,
      sum(m.prints) as impressoes,
      max((m.synced_at at time zone 'America/Sao_Paulo')::date) as sincronizado_em
    from public.daily_ads_campaign_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date >= v_hoje - 21
      and m.metric_date < v_hoje
    group by m.metric_date
  ),
  consolidado as (
    select max(r.metric_date) as dia
    from recentes r
    where r.metric_date < r.sincronizado_em and r.vendas > 0 and r.impressoes > 0
  )
  select
    (select c.dia from consolidado c),
    coalesce((
      select jsonb_agg(r.metric_date order by r.metric_date)
      from recentes r
      where r.custo > 0
        and r.metric_date > coalesce((select c.dia from consolidado c), v_hoje - 22)
    ), '[]'::jsonb)
  into v_fim, v_pendentes;

  if v_fim is null then
    return jsonb_build_object(
      'janela', jsonb_build_object('inicio', null, 'fim', null, 'anterior_inicio', null, 'anterior_fim', null,
                                   'dias_pendentes', v_pendentes),
      'referencias', jsonb_build_object('ctr_mediano', null, 'conversao_mediana', null, 'roas_piso', v_roas_piso),
      'resumo', jsonb_build_object('campanhas', 0, 'critico', 0, 'abaixo_meta', 0, 'atencao', 0, 'escala', 0, 'normal', 0, 'pausada', 0,
                                   'investimento', 0, 'receita_ads', 0, 'roas', null,
                                   'investimento_anterior', 0, 'receita_ads_anterior', 0, 'roas_anterior', null),
      'campanhas', '[]'::jsonb
    );
  end if;

  return (
  with semanas as materialized (
    select
      m.ml_account_id,
      m.campaign_id,
      sum(m.cost) filter (where m.metric_date > v_fim - 7) as custo,
      sum(m.total_amount) filter (where m.metric_date > v_fim - 7) as receita,
      sum(m.units) filter (where m.metric_date > v_fim - 7) as unidades,
      sum(m.clicks) filter (where m.metric_date > v_fim - 7) as cliques,
      sum(m.prints) filter (where m.metric_date > v_fim - 7) as impressoes,
      count(*) filter (where m.metric_date > v_fim - 7) as dias,
      sum(m.cost) filter (where m.metric_date <= v_fim - 7) as custo_ant,
      sum(m.total_amount) filter (where m.metric_date <= v_fim - 7) as receita_ant,
      sum(m.units) filter (where m.metric_date <= v_fim - 7) as unidades_ant,
      sum(m.clicks) filter (where m.metric_date <= v_fim - 7) as cliques_ant,
      sum(m.prints) filter (where m.metric_date <= v_fim - 7) as impressoes_ant
    from public.daily_ads_campaign_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date > v_fim - 14
      and m.metric_date <= v_fim
    group by m.ml_account_id, m.campaign_id
  ),
  -- Dias no teto: gasto de pelo menos 90% do orçamento DIÁRIO de hoje. O
  -- orçamento é o da última leitura, não o de cada dia (ressalva na tela).
  teto as (
    select m.ml_account_id, m.campaign_id, count(*) as dias_no_teto
    from public.daily_ads_campaign_metrics m
    join public.ads_campaigns ca on ca.ml_account_id = m.ml_account_id and ca.campaign_id = m.campaign_id
    where m.organization_id = p_organization_id
      and m.metric_date > v_fim - 7
      and m.metric_date <= v_fim
      and ca.budget > 0
      and m.cost >= 0.9 * ca.budget
    group by m.ml_account_id, m.campaign_id
  ),
  medidas as materialized (
    select
      s.*,
      a.label as conta,
      ca.name as nome,
      ca.status,
      ca.strategy as estrategia,
      ca.budget as orcamento,
      ca.roas_target as roas_alvo,
      ca.acos_target as acos_alvo,
      coalesce(t.dias_no_teto, 0) as dias_no_teto,
      s.receita / nullif(s.custo, 0) as roas,
      s.custo / nullif(s.receita, 0) as acos,
      s.cliques::numeric / nullif(s.impressoes, 0) as ctr,
      s.custo / nullif(s.cliques, 0) as cpc,
      s.unidades::numeric / nullif(s.cliques, 0) as conversao,
      s.custo / nullif(s.unidades, 0) as cpa,
      s.receita / nullif(s.unidades, 0) as ticket,
      s.custo / 7 / nullif(ca.budget, 0) as uso_orcamento,
      s.receita_ant / nullif(s.custo_ant, 0) as roas_ant,
      s.custo_ant / nullif(s.cliques_ant, 0) as cpc_ant,
      s.unidades_ant::numeric / nullif(s.cliques_ant, 0) as conversao_ant
    from semanas s
    join public.ml_accounts a on a.id = s.ml_account_id
    left join public.ads_campaigns ca on ca.ml_account_id = s.ml_account_id and ca.campaign_id = s.campaign_id
    left join teto t on t.ml_account_id = s.ml_account_id and t.campaign_id = s.campaign_id
    where coalesce(s.custo, 0) > 0 or coalesce(s.custo_ant, 0) > 0
  ),
  -- As referências da semana: a mediana das campanhas com volume, não um
  -- número fixo. CTR baixo e conversão baixa são "contra as suas campanhas".
  referencias as (
    select
      percentile_cont(0.5) within group (order by m.ctr) filter (where m.impressoes >= 1000) as ctr_mediano,
      percentile_cont(0.5) within group (order by m.conversao) filter (where m.cliques >= 50) as conversao_mediana
    from medidas m
  ),
  sinais as (
    select
      m.*,
      (coalesce(m.custo, 0) >= greatest(50, coalesce(m.orcamento, 0)) and coalesce(m.unidades, 0) = 0) as sem_venda,
      (coalesce(m.custo, 0) >= 50 and coalesce(m.unidades, 0) > 0 and m.roas < 1) as roas_abaixo_de_1,
      (coalesce(m.custo, 0) >= 50 and coalesce(m.unidades, 0) > 0 and m.roas_alvo > 0 and m.roas < v_roas_piso * m.roas_alvo) as abaixo_da_meta,
      (coalesce(m.cliques, 0) >= 100 and coalesce(m.cliques_ant, 0) >= 100
        and m.cpc >= 1.2 * m.cpc_ant and m.conversao <= 0.85 * m.conversao_ant) as cpc_sobe_conversao_cai,
      (coalesce(m.custo_ant, 0) >= 100 and m.custo >= 1.2 * m.custo_ant
        and m.roas_ant > 0 and m.roas <= 0.85 * m.roas_ant) as gasto_sobe_roas_cai,
      (coalesce(m.impressoes, 0) >= 1000 and r.ctr_mediano > 0 and m.ctr < 0.7 * r.ctr_mediano) as ctr_baixo,
      (coalesce(m.cliques, 0) >= 100 and r.conversao_mediana > 0 and m.conversao < 0.6 * r.conversao_mediana) as conversao_baixa,
      (m.status = 'active' and m.roas_alvo > 0 and m.roas >= m.roas_alvo
        and (m.uso_orcamento >= 0.9 or m.dias_no_teto >= 4) and coalesce(m.unidades, 0) >= 5) as no_teto_acima_da_meta
    from medidas m
    cross join referencias r
  ),
  classificado as materialized (
    select
      s.*,
      case
        -- Pausada: quem pausou já agiu; o sinal da semana em que gastou não
        -- vira alerta, e a campanha fica na tabela.
        when s.status is distinct from 'active' then 'pausada'
        when s.sem_venda or s.roas_abaixo_de_1 then 'critico'
        when s.abaixo_da_meta then 'abaixo_meta'
        when s.cpc_sobe_conversao_cai or s.gasto_sobe_roas_cai then 'atencao'
        when s.no_teto_acima_da_meta then 'escala'
        else 'normal'
      end as nivel
    from sinais s
  )
  select jsonb_build_object(
    'janela', jsonb_build_object(
      'inicio', v_fim - 6,
      'fim', v_fim,
      'anterior_inicio', v_fim - 13,
      'anterior_fim', v_fim - 7,
      'dias_pendentes', v_pendentes
    ),
    'referencias', (
      select jsonb_build_object(
        'ctr_mediano', round(r.ctr_mediano::numeric, 4),
        'conversao_mediana', round(r.conversao_mediana::numeric, 4),
        'roas_piso', v_roas_piso
      )
      from referencias r
    ),
    'resumo', (
      select jsonb_build_object(
        'campanhas', count(*),
        'critico', count(*) filter (where c.nivel = 'critico'),
        'abaixo_meta', count(*) filter (where c.nivel = 'abaixo_meta'),
        'atencao', count(*) filter (where c.nivel = 'atencao'),
        'escala', count(*) filter (where c.nivel = 'escala'),
        'normal', count(*) filter (where c.nivel = 'normal'),
        'pausada', count(*) filter (where c.nivel = 'pausada'),
        'investimento', round(coalesce(sum(c.custo), 0), 2),
        'receita_ads', round(coalesce(sum(c.receita), 0), 2),
        'roas', round(sum(c.receita) / nullif(sum(c.custo), 0), 2),
        'investimento_anterior', round(coalesce(sum(c.custo_ant), 0), 2),
        'receita_ads_anterior', round(coalesce(sum(c.receita_ant), 0), 2),
        'roas_anterior', round(sum(c.receita_ant) / nullif(sum(c.custo_ant), 0), 2)
      )
      from classificado c
    ),
    'campanhas', coalesce((
      select jsonb_agg(jsonb_build_object(
          'ml_account_id', c.ml_account_id,
          'conta', c.conta,
          'campaign_id', c.campaign_id,
          'nome', coalesce(c.nome, 'campanha ' || c.campaign_id::text),
          'status', c.status,
          'estrategia', c.estrategia,
          'orcamento', c.orcamento,
          'roas_alvo', c.roas_alvo,
          'acos_alvo', c.acos_alvo,
          'nivel', c.nivel,
          'investimento', round(coalesce(c.custo, 0), 2),
          'receita_ads', round(coalesce(c.receita, 0), 2),
          'unidades', coalesce(c.unidades, 0),
          'cliques', coalesce(c.cliques, 0),
          'impressoes', coalesce(c.impressoes, 0),
          'dias', c.dias,
          'dias_no_teto', c.dias_no_teto,
          'roas', round(c.roas, 2),
          'acos', round(c.acos, 4),
          'ctr', round(c.ctr, 4),
          'cpc', round(c.cpc, 2),
          'conversao', round(c.conversao, 4),
          'cpa', round(c.cpa, 2),
          'ticket', round(c.ticket, 2),
          'uso_orcamento', round(c.uso_orcamento, 4),
          'investimento_anterior', round(coalesce(c.custo_ant, 0), 2),
          'receita_ads_anterior', round(coalesce(c.receita_ant, 0), 2),
          'unidades_anterior', coalesce(c.unidades_ant, 0),
          'cliques_anterior', coalesce(c.cliques_ant, 0),
          'roas_anterior', round(c.roas_ant, 2),
          'cpc_anterior', round(c.cpc_ant, 2),
          'conversao_anterior', round(c.conversao_ant, 4),
          'sinais', jsonb_build_object(
            'sem_venda', c.sem_venda,
            'roas_abaixo_de_1', c.roas_abaixo_de_1,
            'abaixo_da_meta', c.abaixo_da_meta,
            'cpc_sobe_conversao_cai', c.cpc_sobe_conversao_cai,
            'gasto_sobe_roas_cai', c.gasto_sobe_roas_cai,
            'ctr_baixo', c.ctr_baixo,
            'conversao_baixa', c.conversao_baixa,
            'no_teto_acima_da_meta', c.no_teto_acima_da_meta
          )
        ) order by
          case c.nivel when 'critico' then 1 when 'abaixo_meta' then 2 when 'atencao' then 3 when 'escala' then 4 when 'normal' then 5 else 6 end,
          c.custo desc nulls last, c.campaign_id)
      from classificado c
    ), '[]'::jsonb)
  )
  );
end
$fn$;
