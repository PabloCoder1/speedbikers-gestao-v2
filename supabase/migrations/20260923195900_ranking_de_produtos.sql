create or replace function public.get_ranking_produtos(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_ordem text default 'receita',
  p_limite integer default 50,
  p_offset integer default 0,
  p_anterior_from date default null,
  p_anterior_to date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  -- Sem periodo anterior explicito, o de mesmo tamanho logo antes.
  v_anterior_de date := coalesce(p_anterior_from, p_date_from - (p_date_to - p_date_from + 1));
  v_anterior_ate date := coalesce(p_anterior_to, p_date_from - 1);
  v_corte timestamptz := p_date_from::timestamp at time zone 'America/Sao_Paulo';
begin
  if p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to using errcode = '22023';
  end if;
  if v_anterior_ate < v_anterior_de or v_anterior_ate >= p_date_from then
    raise exception 'periodo anterior invalido: % a %', v_anterior_de, v_anterior_ate using errcode = '22023';
  end if;
  if p_ordem is null or p_ordem not in
     ('receita', 'lucro', 'margem', 'menor_margem', 'volume', 'frete', 'prejuizo', 'crescimento', 'queda_margem') then
    raise exception 'ordem desconhecida: %', p_ordem using errcode = '22023';
  end if;
  if p_limite is null or p_limite < 1 or p_limite > 100 or p_offset is null or p_offset < 0 then
    raise exception 'pagina invalida: limite % offset %', p_limite, p_offset using errcode = '22023';
  end if;

  return (
  -- D-402: as CTEs de custo sao as de get_faturamento (D-356/D-395), sem
  -- mudanca. A janela vai do inicio do periodo anterior ao fim do atual, sem
  -- o intervalo entre os dois (mes atual contra os mesmos dias do anterior),
  -- e o pedido leva `atual` para separar os periodos na agregacao por SKU.
  with bounds as (
    select (v_anterior_de::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to,
           ((v_anterior_ate + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_anterior_ate,
           v_corte as ts_corte
  ),
  pedidos as materialized (
    select o.id, o.organization_id, o.ml_account_id, o.pack_id, o.date_created
    from public.orders o
    cross join bounds b
    where o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and o.status in ('paid', 'partially_refunded')
      and (o.date_created < b.ts_anterior_ate or o.date_created >= b.ts_corte)
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
      and (t.ate is null or t.ate > (v_anterior_de::timestamp at time zone 'America/Sao_Paulo'))
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
      bool_or(l.sku_id is null) as sem_sku,
      l.date_created >= v_corte as atual
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
      p.atual,
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
  -- Por SKU, os dois periodos numa agregacao. Resultado e margem SO sobre
  -- pedidos cobertos, como em get_faturamento: o teste de integracao confere
  -- a igualdade do periodo atual com o `por_sku` de la.
  por_sku as materialized (
    select
      l.sku_id,
      sum(l.quantity) filter (where k.atual) as unidades,
      count(distinct l.order_id) filter (where k.atual) as pedidos,
      round(sum(l.receita) filter (where k.atual), 2) as receita_bruta,
      round(sum(l.comissao) filter (where k.atual), 2) as taxas_ml,
      count(*) filter (where k.atual and k.coberto) as pedidos_cobertos,
      round(sum(l.receita) filter (where k.atual and k.coberto), 2) as receita_coberta,
      round(sum(l.comissao) filter (where k.atual and k.coberto), 2) as taxas_ml_cobertas,
      round(sum(k.frete) filter (where k.atual and k.coberto), 2) as frete_vendedor,
      round(sum(k.custo) filter (where k.atual and k.coberto), 2) as custo_produtos,
      round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.atual and k.coberto), 2) as resultado_venda,
      round(
        sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.atual and k.coberto)
        / nullif(sum(k.receita) filter (where k.atual and k.coberto), 0), 4) as margem_venda,
      -- D-395: imposto so quando TODO pedido coberto do SKU tem aliquota.
      case
        when count(*) filter (where k.atual and k.coberto) > 0
         and bool_and(k.aliquota is not null) filter (where k.atual and k.coberto)
        then round(sum(k.imposto) filter (where k.atual and k.coberto), 2)
      end as imposto,
      case
        when count(*) filter (where k.atual and k.coberto) > 0
         and bool_and(k.aliquota is not null) filter (where k.atual and k.coberto)
        then round(sum(k.receita - k.comissao - k.frete - k.custo - k.imposto) filter (where k.atual and k.coberto), 2)
      end as resultado_apos_imposto,
      case
        when count(*) filter (where k.atual and k.coberto) > 0
         and bool_and(k.aliquota is not null) filter (where k.atual and k.coberto)
        then round(
          sum(k.receita - k.comissao - k.frete - k.custo - k.imposto) filter (where k.atual and k.coberto)
          / nullif(sum(k.receita) filter (where k.atual and k.coberto), 0), 4)
      end as margem_apos_imposto,
      coalesce(bool_or(k.custo_atual) filter (where k.atual and k.coberto), false) as custo_atual,
      count(distinct l.order_id) filter (where not k.atual) as pedidos_anterior,
      sum(l.quantity) filter (where not k.atual) as unidades_anterior,
      round(sum(l.receita) filter (where not k.atual), 2) as receita_anterior,
      count(*) filter (where not k.atual and k.coberto) as pedidos_cobertos_anterior,
      round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where not k.atual and k.coberto), 2) as resultado_anterior,
      round(
        sum(k.receita - k.comissao - k.frete - k.custo) filter (where not k.atual and k.coberto)
        / nullif(sum(k.receita) filter (where not k.atual and k.coberto), 0), 4) as margem_anterior
    from linhas l
    join classificado k on k.order_id = l.order_id
    where l.sku_id is not null
    group by l.sku_id
  ),
  -- So os SKUs que venderam no periodo. Crescimento e queda de margem so com
  -- 5 pedidos nos dois periodos (5 cobertos, para a margem): com menos, uma
  -- venda a mais vira +100%.
  atual as materialized (
    select
      b.*,
      case when b.pedidos >= 5 and b.pedidos_anterior >= 5
           then round(b.receita_bruta / nullif(b.receita_anterior, 0) - 1, 4) end as variacao_receita,
      case when b.pedidos_cobertos >= 5 and b.pedidos_cobertos_anterior >= 5
           then round(b.margem_venda - b.margem_anterior, 4) end as variacao_margem,
      round(b.frete_vendedor / nullif(b.receita_coberta, 0), 4) as frete_sobre_receita
    from por_sku b
    where b.pedidos > 0
  ),
  -- Quantos SKUs, dos de maior resultado, somam metade do resultado de todos.
  -- Sem resultado positivo no total, NULL.
  concentracao as (
    select min(c.posicao) as skus
    from (
      select
        row_number() over (order by a.resultado_venda desc, a.sku_id) as posicao,
        sum(a.resultado_venda) over (order by a.resultado_venda desc, a.sku_id) as acumulado,
        sum(a.resultado_venda) over () as total
      from atual a
      where a.resultado_venda is not null
    ) c
    where c.total > 0
      and c.acumulado >= c.total / 2
  ),
  -- A ordem pedida vira uma chave so, decrescente. "Maior margem" exige 3
  -- pedidos cobertos (uma venda so no topo nao diz nada); "menor margem" e
  -- "prejuizo" nao: uma venda com prejuizo ja e o que se quer ver.
  filtrado as materialized (
    select
      a.*,
      case p_ordem
        when 'receita' then a.receita_bruta
        when 'lucro' then a.resultado_venda
        when 'margem' then a.margem_venda
        when 'menor_margem' then -a.margem_venda
        when 'volume' then a.unidades
        when 'frete' then a.frete_vendedor
        when 'prejuizo' then -a.resultado_venda
        when 'crescimento' then a.variacao_receita
        when 'queda_margem' then -a.variacao_margem
      end as chave
    from atual a
    where case p_ordem
      when 'lucro' then a.resultado_venda is not null
      when 'margem' then a.margem_venda is not null and a.pedidos_cobertos >= 3
      when 'menor_margem' then a.margem_venda is not null
      when 'frete' then a.frete_vendedor > 0
      when 'prejuizo' then a.resultado_venda < 0
      when 'crescimento' then a.variacao_receita is not null
      when 'queda_margem' then a.variacao_margem < 0
      else true
    end
  ),
  pagina as (
    select f.*, s.sku, s.title
    from filtrado f
    join public.skus s on s.id = f.sku_id
    order by f.chave desc, f.receita_bruta desc, f.sku_id
    limit p_limite offset p_offset
  )
  select jsonb_build_object(
    'periodo', jsonb_build_object(
      'inicio', p_date_from,
      'fim', p_date_to,
      'anterior_inicio', v_anterior_de,
      'anterior_fim', v_anterior_ate
    ),
    'ordem', p_ordem,
    'resumo', (
      select jsonb_build_object(
        'skus_com_venda', count(*),
        -- Os totais dos itens com SKU, para dar contexto ao crescimento de cada um.
        'receita_bruta', (select round(sum(b.receita_bruta), 2) from por_sku b),
        'receita_bruta_anterior', (select round(sum(b.receita_anterior), 2) from por_sku b),
        'skus_cobertos', count(*) filter (where a.pedidos_cobertos > 0),
        'resultado_venda', round(sum(a.resultado_venda), 2),
        'skus_prejuizo', count(*) filter (where a.resultado_venda < 0),
        'prejuizo', round(sum(a.resultado_venda) filter (where a.resultado_venda < 0), 2),
        'skus_margem_abaixo_10', count(*) filter (where a.margem_venda < 0.10),
        'skus_comparaveis', count(*) filter (where a.variacao_receita is not null),
        'skus_crescendo', count(*) filter (where a.variacao_receita >= 0.30),
        'skus_margem_comparavel', count(*) filter (where a.variacao_margem is not null),
        'skus_queda_margem', count(*) filter (where a.variacao_margem <= -0.05),
        'skus_metade_do_resultado', (select c.skus from concentracao c)
      )
      from atual a
    ),
    'total', (select count(*) from filtrado),
    'itens', (
      select coalesce(jsonb_agg(to_jsonb(p) - 'chave' order by p.chave desc, p.receita_bruta desc, p.sku_id), '[]'::jsonb)
      from pagina p
    )
  )
  );
end;
$$;

comment on function public.get_ranking_produtos(date, date, uuid, text, integer, integer, date, date) is
  'D-402: ranking de produtos do periodo contra um periodo anterior (por padrao o de mesmo tamanho logo antes) -- receita, lucro (resultado da venda), maior e menor margem, volume, frete, prejuizo, crescimento e queda de margem. Custos de get_faturamento (D-356/D-395) numa passada so pelos dois periodos; resultado e margem so sobre pedidos cobertos, NULL quando nao observado. Ads por produto nao existe na API. Pagina de ate 100. security invoker.';

revoke all on function public.get_ranking_produtos(date, date, uuid, text, integer, integer, date, date) from public, anon;
grant execute on function public.get_ranking_produtos(date, date, uuid, text, integer, integer, date, date) to authenticated, service_role;

-- O catálogo espelha docs/METRICS.md 5N (D-023).
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions,
   cancellation_treatment, timezone, definition_updated_on)
values
  ('variacao_receita_produto', 'Crescimento da receita do produto',
   'receita bruta do SKU no período ÷ receita bruta no período anterior − 1',
   'orders + order_items (get_ranking_produtos)', array['sku'],
   'Pedidos válidos; o período anterior é o da comparação da central (por padrão, o de mesmo tamanho logo antes).',
   'SKU com menos de 5 pedidos em algum dos dois períodos: NULL, nunca 0 -- uma venda a mais viraria +100%.',
   'excluded', 'America/Sao_Paulo', date '2026-09-24'),
  ('variacao_margem_produto', 'Variação da margem do produto',
   'margem da venda do SKU no período − margem no período anterior, em pontos percentuais',
   'get_ranking_produtos, com os custos de get_faturamento (D-356)', array['sku'],
   'Só pedidos cobertos (frete observado, custo conhecido, uma linha de item), como margem_venda.',
   'SKU com menos de 5 pedidos cobertos em algum dos dois períodos: NULL.',
   'excluded', 'America/Sao_Paulo', date '2026-09-24'),
  ('concentracao_resultado', 'SKUs que fazem metade do resultado',
   'menor N tal que os N SKUs de maior resultado da venda somam metade do resultado de todos os SKUs com resultado conhecido',
   'get_ranking_produtos', array['organization', 'account'],
   'Resultado da venda sobre pedidos cobertos (5F).',
   'Sem resultado total positivo: NULL. Não inclui imposto, Ads nem custos fixos.',
   'excluded', 'America/Sao_Paulo', date '2026-09-24');
