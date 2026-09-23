-- D-397 — Detector de frete possivelmente errado (trilha 5J).
--
-- Uma RPC, `get_detector_frete`, que compara o frete de cada anúncio com
-- quatro referências e devolve só os que destoam, com os números de cada
-- comparação -- o texto do motivo é montado na tela a partir deles
-- (`apps/web/lib/detector-frete.ts`), nunca inventado.
--
-- O QUE FOI MEDIDO ANTES (produção, 30 dias até 23/09/2026):
--   * todo pedido tem UMA linha e 98% têm UMA unidade: o frete do pedido é o
--     frete do anúncio (regra de 5E);
--   * o frete de um anúncio é quase fixo -- coeficiente de variação mediano
--     de 1% a 3%, ~2 valores distintos em 30 dias. Mudança de 15% já é fora
--     do normal;
--   * o frete acompanha a FAIXA DE PREÇO (mediana ~R$ 7 abaixo de R$ 40,
--     ~R$ 8,45 de R$ 40 a 79, ~R$ 14,45 de R$ 79 a 120, subindo depois).
--     "Desproporcional" é medido contra a faixa, não por um limite fixo: abaixo
--     de R$ 40, 21% do preço é a mediana;
--   * 225 SKUs vendem por mais de um anúncio e em 31 o frete difere > 15%
--     entre eles -- mesmo produto, frete diferente: o indício mais direto de
--     medida ou peso cadastrado errado no anúncio;
--   * peso cadastrado em 22 de 973 SKUs vendidos: NÃO há comparação por peso
--     ou dimensões. A resposta conta quantos têm, para a tela dizer;
--   * a categoria do ERP (`skus.category_raw`) NÃO é categoria de produto --
--     mistura fornecedor ("NAVETEC"), situação ("ESTOQUE INATIVO") e grupo de
--     peça ("MANETE→CB 300R"); no protótipo, baús de 45 l viraram "pares" de
--     peças pequenas do mesmo fornecedor. Os pares usam a categoria do Mercado
--     Livre do anúncio (`listings.category_id`, 1.864 de 1.865 anúncios
--     vendidos em 14 dias).
--
-- O GRÃO é o par (anúncio, faixa de preço do PEDIDO): o frete é do anúncio
-- (medidas declaradas) e depende da faixa -- um anúncio que vende dos dois
-- lados de R$ 79 vira duas linhas, cada uma comparada dentro da sua faixa (no
-- protótipo, um preço rondando R$ 79 misturava dois fretes e parecia alta).
-- O SKU da linha é o mais frequente nos pedidos do anúncio; anúncio sem SKU
-- vinculado entra e, nos pares, conta como produto próprio.
--
-- AS JANELAS: "atual" são os 14 dias até ontem; "antes" são os 76 dias
-- anteriores (90 no total, o que D-396 recuperou). Hoje fica de fora: o frete
-- do dia ainda não foi capturado.
--
-- O QUE ENTRA: pedidos válidos (paid, partially_refunded) com frete observado
-- (D-165), uma linha e uma unidade, fora do Flex (`self_service`: o vendedor
-- entrega e o frete medido é ~zero). Pedido sem frete observado não vira zero:
-- não entra.
--
-- OS CINCO SINAIS, cada um de 0 a 3 pontos (margem até 2), somados:
--   historico  -- frete atual contra o do próprio anúncio antes, na mesma
--                 faixa (mediana contra mediana). Limiar: 15% ou 3x a dispersão
--                 do próprio anúncio, o que for maior, e R$ 1 no mínimo.
--   irmaos     -- contra os outros anúncios do MESMO SKU na mesma faixa.
--   pares      -- contra outros produtos da mesma categoria do Mercado Livre e
--                 mesma faixa (6 produtos no mínimo), mediana e desvio absoluto
--                 mediano: pede distância relativa E z robusto, com limiares
--                 mais altos que os dos irmãos (50%/100%/200%), porque a
--                 categoria mistura tamanhos -- faróis contra lanternas.
--   proporcao  -- frete ÷ preço contra o p95 da faixa (e pisos de 25/30/40%).
--   margem     -- deixou de ser rentável com o frete explicando pelo menos
--                 metade da queda (2); ou vende no prejuízo com frete >= 10%
--                 do preço (1); ou o frete subiu >= 5 p.p. do preço e a margem
--                 caiu junto, quando conhecida (1).
-- Nível: 0 normal, 1-2 atenção, 3-4 provável problema, 5+ forte indício.
--
-- A MARGEM usa a regra de custo de `get_faturamento` (D-356) copiada sem
-- mudança -- histórico com vigência, kits pelos componentes. O teste de
-- integração "detector de frete" confere que a margem daqui é a mesma de
-- `get_faturamento` nos mesmos pedidos: se uma mudar sem a outra, ele quebra.

create or replace function public.get_detector_frete(
  p_organization_id uuid,
  p_hoje date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_hoje date := coalesce(p_hoje, (now() at time zone 'America/Sao_Paulo')::date);
  v_ini timestamptz := ((v_hoje - 90)::timestamp at time zone 'America/Sao_Paulo');
  v_corte timestamptz := ((v_hoje - 14)::timestamp at time zone 'America/Sao_Paulo');
  v_fim timestamptz := (v_hoje::timestamp at time zone 'America/Sao_Paulo');
begin
  return (
  with pedidos as materialized (
    select o.id, o.organization_id, o.ml_account_id, o.date_created, f.seller_shipping_cost as frete
    from public.orders o
    join public.order_financials f on f.order_id = o.id
    where o.organization_id = p_organization_id
      and o.date_created >= v_ini
      and o.date_created < v_fim
      and o.status in ('paid', 'partially_refunded')
      and o.logistic_type is distinct from 'self_service'
      and f.seller_shipping_cost is not null
  ),
  -- `item_id` aqui é o id da LINHA, como em `get_faturamento` -- as CTEs de
  -- custo abaixo são as dela, sem mudança. O anúncio do Mercado Livre é
  -- `anuncio`.
  linhas as materialized (
    select
      p.id as order_id,
      p.ml_account_id,
      p.date_created,
      p.frete,
      oi.id as item_id,
      oi.item_id as anuncio,
      oi.sku_id,
      oi.title,
      oi.quantity,
      oi.unit_price as preco,
      oi.sale_fee as comissao
    from pedidos p
    cross join lateral (
      select i.id, i.item_id, i.sku_id, i.title, i.quantity, i.unit_price, i.sale_fee,
             count(*) over () as linhas
      from public.order_items i
      where i.order_id = p.id
        and i.organization_id = p.organization_id
        and i.ml_account_id = p.ml_account_id
      offset 0
    ) oi
    where oi.linhas = 1
      and oi.quantity = 1
  ),
  -- ── custo: as CTEs de get_faturamento (D-356), só com as datas da janela ──
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
    where t.desde < v_fim
      and (t.ate is null or t.ate > v_ini)
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
      end * l.quantity as custo
    from linhas l
    join public.skus s on s.id = l.sku_id
    left join historico hs
      on hs.sku_id = s.id
     and hs.desde <= l.date_created
     and (hs.ate is null or l.date_created < hs.ate)
    left join custo_kit k on k.item_id = l.item_id
  ),
  -- ── fim das CTEs de custo ──
  vendas as materialized (
    select
      l.anuncio || ':' || fx.faixa as chave,
      l.anuncio,
      fx.faixa,
      l.sku_id,
      l.ml_account_id,
      l.title,
      l.date_created,
      l.date_created >= v_corte as atual,
      l.preco,
      l.comissao,
      l.frete,
      c.custo,
      (l.comissao is not null and c.custo is not null) as coberto
    from linhas l
    left join custo c on c.item_id = l.item_id
    cross join lateral (
      select case
        when l.preco < 40 then 'ate_40'
        when l.preco < 79 then '40_79'
        when l.preco < 120 then '79_120'
        when l.preco < 200 then '120_200'
        when l.preco < 400 then '200_400'
        else 'acima_400'
      end as faixa
    ) fx
  ),
  por_janela as materialized (
    select
      v.chave,
      v.atual,
      max(v.anuncio) as anuncio,
      max(v.faixa) as faixa,
      mode() within group (order by v.sku_id) filter (where v.sku_id is not null) as sku_id,
      max(v.ml_account_id::text)::uuid as ml_account_id,
      max(v.title) as titulo,
      count(*) as n,
      percentile_cont(0.5) within group (order by v.frete) as frete_med,
      percentile_cont(0.5) within group (order by v.preco) as preco_med,
      sum(v.frete) as frete_soma,
      sum(v.preco) as receita,
      count(*) filter (where v.coberto) as n_cob,
      sum(v.preco) filter (where v.coberto) as receita_cob,
      sum(v.preco - v.comissao - v.frete - v.custo) filter (where v.coberto) as resultado_cob
    from vendas v
    group by v.chave, v.atual
  ),
  dispersao_antes as (
    select v.chave, percentile_cont(0.5) within group (order by abs(v.frete - j.frete_med)) as mad
    from vendas v
    join por_janela j on j.chave = v.chave and not j.atual
    where not v.atual
    group by v.chave
  ),
  anuncios as materialized (
    select
      a.chave,
      a.anuncio,
      coalesce(a.sku_id, b.sku_id) as sku_id,
      a.ml_account_id,
      a.titulo,
      s.sku,
      li.categoria,
      s.weight_g is not null as tem_peso,
      a.n as n_atual,
      a.frete_med as frete_atual,
      a.frete_soma as frete_soma_atual,
      a.preco_med as preco_atual,
      a.faixa,
      a.frete_soma / nullif(a.receita, 0) as frete_share_atual,
      a.n_cob as cob_atual,
      a.resultado_cob / nullif(a.receita_cob, 0) as margem_atual,
      coalesce(b.n, 0) as n_antes,
      b.frete_med as frete_antes,
      b.preco_med as preco_antes,
      b.frete_soma / nullif(b.receita, 0) as frete_share_antes,
      coalesce(b.n_cob, 0) as cob_antes,
      b.resultado_cob / nullif(b.receita_cob, 0) as margem_antes,
      d.mad as mad_antes
    from por_janela a
    left join por_janela b on b.chave = a.chave and not b.atual
    left join dispersao_antes d on d.chave = a.chave
    left join public.skus s on s.id = coalesce(a.sku_id, b.sku_id)
    left join lateral (
      select l.category_id as categoria
      from public.listings l
      where l.ml_account_id = a.ml_account_id
        and l.item_id = a.anuncio
    ) li on true
    where a.atual
      and a.n >= 3
  ),
  irmaos as (
    select a.chave, count(*) as n_irmaos,
           percentile_cont(0.5) within group (order by b.frete_atual) as frete_irmaos
    from anuncios a
    join anuncios b on b.sku_id = a.sku_id and b.faixa = a.faixa and b.anuncio <> a.anuncio
    group by a.chave
  ),
  -- Um valor por produto (a mediana dos seus anúncios na faixa): SKU com
  -- muitos anúncios não pesa mais que os outros no grupo. Anúncio sem SKU é
  -- o seu próprio produto.
  pares_sku as (
    select a.categoria, a.faixa, coalesce(a.sku_id::text, a.anuncio) as produto,
           percentile_cont(0.5) within group (order by a.frete_atual) as frete
    from anuncios a
    where a.categoria is not null
    group by a.categoria, a.faixa, coalesce(a.sku_id::text, a.anuncio)
  ),
  pares_grupo as (
    select p.categoria, p.faixa, count(*) as skus,
           percentile_cont(0.5) within group (order by p.frete) as mediana
    from pares_sku p
    group by p.categoria, p.faixa
    having count(*) >= 6
  ),
  pares as (
    select g.categoria, g.faixa, g.skus, g.mediana,
           percentile_cont(0.5) within group (order by abs(p.frete - g.mediana)) as mad
    from pares_grupo g
    join pares_sku p on p.categoria = g.categoria and p.faixa = g.faixa
    group by g.categoria, g.faixa, g.skus, g.mediana
  ),
  faixas as (
    select a.faixa, count(*) as anuncios,
           percentile_cont(0.5) within group (order by a.frete_atual / nullif(a.preco_atual, 0)) as razao_mediana,
           percentile_cont(0.95) within group (order by a.frete_atual / nullif(a.preco_atual, 0)) as razao_p95
    from anuncios a
    group by a.faixa
  ),
  medidas as (
    select
      a.*,
      i.n_irmaos,
      i.frete_irmaos,
      p.skus as n_pares,
      p.mediana as frete_pares,
      f.razao_p95,
      a.frete_atual / nullif(a.preco_atual, 0) as razao,
      greatest(0.15, 3 * coalesce(a.mad_antes, 0) / nullif(a.frete_antes, 0)) as limiar_historico,
      a.frete_atual / nullif(a.frete_antes, 0) - 1 as var_historico,
      a.frete_atual / nullif(i.frete_irmaos, 0) - 1 as var_irmaos,
      a.frete_atual / nullif(p.mediana, 0) - 1 as var_pares,
      case
        when p.mad is null then null
        when p.mad > 0 then (a.frete_atual - p.mediana) / (1.4826 * p.mad)
        when a.frete_atual > p.mediana then 99
        else 0
      end as z_pares
    from anuncios a
    left join irmaos i on i.chave = a.chave
    left join pares p on p.categoria = a.categoria and p.faixa = a.faixa
    left join faixas f on f.faixa = a.faixa
  ),
  pontos as (
    select
      m.*,
      case
        when m.n_antes >= 5 and m.frete_antes > 0
             and m.frete_atual - m.frete_antes >= 1 then
          case
            when m.var_historico >= greatest(0.80, m.limiar_historico) then 3
            when m.var_historico >= greatest(0.40, m.limiar_historico) then 2
            when m.var_historico >= m.limiar_historico then 1
            else 0
          end
        else 0
      end as p_historico,
      case
        when m.frete_irmaos > 0 and m.frete_atual - m.frete_irmaos >= 1 then
          case
            when m.var_irmaos >= 0.80 then 3
            when m.var_irmaos >= 0.40 then 2
            when m.var_irmaos >= 0.15 then 1
            else 0
          end
        else 0
      end as p_irmaos,
      case
        when m.frete_pares > 0 and m.frete_atual - m.frete_pares >= 2 then
          case
            when m.var_pares >= 2.00 and m.z_pares >= 6 then 3
            when m.var_pares >= 1.00 and m.z_pares >= 4 then 2
            when m.var_pares >= 0.50 and m.z_pares >= 3 then 1
            else 0
          end
        else 0
      end as p_pares,
      case
        when m.razao >= greatest(2 * m.razao_p95, 0.40) then 3
        when m.razao >= greatest(1.5 * m.razao_p95, 0.30) then 2
        when m.razao > m.razao_p95 and m.razao >= 0.25 then 1
        else 0
      end as p_proporcao,
      (m.cob_antes >= 5 and m.cob_atual >= 3 and m.margem_antes > 0 and m.margem_atual <= 0
        and m.frete_share_atual - m.frete_share_antes >= (m.margem_antes - m.margem_atual) / 2) as deixou_de_ser_rentavel,
      (m.cob_atual >= 3 and m.margem_atual < 0 and m.frete_share_atual >= 0.10) as prejuizo,
      case when m.n_antes >= 5 then m.frete_share_antes - m.frete_share_atual end as impacto_frete,
      -- O frete tirou 5 p.p. do preço E a margem caiu junto (quando ela é
      -- conhecida nas duas janelas): se o preço ou o custo compensaram, dizer
      -- que o frete "tirou margem" seria falso.
      (m.n_antes >= 5 and m.frete_share_atual - m.frete_share_antes >= 0.05
        and (m.cob_antes < 5 or m.cob_atual < 3 or m.margem_antes - m.margem_atual >= 0.05)) as frete_tirou_margem
    from medidas m
  ),
  pontuado as (
    select
      q.*,
      case
        when q.deixou_de_ser_rentavel then 2
        else least(2, (case when q.prejuizo then 1 else 0 end)
                      + (case when q.frete_tirou_margem then 1 else 0 end))
      end as p_margem
    from pontos q
  ),
  classificado as materialized (
    select
      z.*,
      z.p_historico + z.p_irmaos + z.p_pares + z.p_proporcao + z.p_margem as total,
      case
        when z.p_historico + z.p_irmaos + z.p_pares + z.p_proporcao + z.p_margem >= 5 then 'forte'
        when z.p_historico + z.p_irmaos + z.p_pares + z.p_proporcao + z.p_margem >= 3 then 'provavel'
        when z.p_historico + z.p_irmaos + z.p_pares + z.p_proporcao + z.p_margem >= 1 then 'atencao'
        else 'normal'
      end as nivel,
      -- A referência do "frete a mais": a comparação mais direta que pontuou.
      case
        when z.p_historico > 0 then z.frete_antes
        when z.p_irmaos > 0 then z.frete_irmaos
        when z.p_pares > 0 then z.frete_pares
      end as referencia
    from pontuado z
  ),
  -- Quando o frete do anúncio subiu: o primeiro pedido depois do último que
  -- ainda pagava o frete de antes. Só para quem pontuou no histórico.
  ultimo_frete_antigo as (
    select c.chave, max(v.date_created) as em
    from classificado c
    join vendas v on v.chave = c.chave
    where c.p_historico > 0
      and v.frete <= c.frete_antes * (1 + c.limiar_historico / 2)
    group by c.chave
  ),
  mudanca as (
    select u.chave, min(v.date_created) as desde
    from ultimo_frete_antigo u
    join vendas v on v.chave = u.chave and v.date_created > u.em
    group by u.chave
  )
  select jsonb_build_object(
    'janela', jsonb_build_object(
      'inicio', v_hoje - 90,
      'corte', v_hoje - 14,
      'fim', v_hoje - 1
    ),
    'resumo', (
      select jsonb_build_object(
        'analisados', count(*),
        'anuncios', count(distinct c.anuncio),
        'com_historico', count(*) filter (where c.n_antes >= 5),
        'com_irmaos', count(*) filter (where c.frete_irmaos is not null),
        'com_pares', count(*) filter (where c.frete_pares is not null),
        'normal', count(*) filter (where c.nivel = 'normal'),
        'atencao', count(*) filter (where c.nivel = 'atencao'),
        'provavel', count(*) filter (where c.nivel = 'provavel'),
        'forte', count(*) filter (where c.nivel = 'forte'),
        'excesso_14_dias', round((sum(c.frete_soma_atual - c.referencia * c.n_atual)
                                 filter (where c.nivel in ('provavel', 'forte') and c.referencia is not null))::numeric, 2),
        'skus', count(distinct c.sku_id),
        'skus_com_peso', count(distinct c.sku_id) filter (where c.tem_peso)
      )
      from classificado c
    ),
    'faixas', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'faixa', f.faixa,
        'anuncios', f.anuncios,
        'razao_mediana', round(f.razao_mediana::numeric, 4),
        'razao_p95', round(f.razao_p95::numeric, 4)
      ) order by f.faixa), '[]'::jsonb)
      from faixas f
    ),
    'alertas', (
      select coalesce(jsonb_agg(x.j order by x.total desc, x.excesso desc nulls last, x.chave), '[]'::jsonb)
      from (
        select
          c.total,
          c.chave,
          round((c.frete_soma_atual - c.referencia * c.n_atual)::numeric, 2) as excesso,
          jsonb_build_object(
            'anuncio', c.anuncio,
            'sku_id', c.sku_id,
            'sku', c.sku,
            'titulo', c.titulo,
            'conta', a.label,
            'categoria', c.categoria,
            'nivel', c.nivel,
            'pontos', c.total,
            'faixa', c.faixa,
            'pedidos_atual', c.n_atual,
            'pedidos_antes', c.n_antes,
            'frete_atual', round(c.frete_atual::numeric, 2),
            'frete_antes', round(c.frete_antes::numeric, 2),
            'preco_atual', round(c.preco_atual::numeric, 2),
            'preco_antes', round(c.preco_antes::numeric, 2),
            'razao', round(c.razao::numeric, 4),
            'razao_p95', round(c.razao_p95::numeric, 4),
            'frete_irmaos', round(c.frete_irmaos::numeric, 2),
            'irmaos', c.n_irmaos,
            'frete_pares', round(c.frete_pares::numeric, 2),
            'pares', c.n_pares,
            'z_pares', round(least(c.z_pares, 99)::numeric, 1),
            'margem_atual', round(c.margem_atual::numeric, 4),
            'margem_antes', round(c.margem_antes::numeric, 4),
            'cobertos_atual', c.cob_atual,
            'cobertos_antes', c.cob_antes,
            'frete_share_atual', round(c.frete_share_atual::numeric, 4),
            'frete_share_antes', round(c.frete_share_antes::numeric, 4),
            'impacto_frete', round(c.impacto_frete::numeric, 4),
            'excesso', round((c.frete_soma_atual - c.referencia * c.n_atual)::numeric, 2),
            'mudou_em', (m.desde at time zone 'America/Sao_Paulo')::date,
            'sinais', jsonb_build_object(
              'historico', c.p_historico,
              'irmaos', c.p_irmaos,
              'pares', c.p_pares,
              'proporcao', c.p_proporcao,
              'margem', c.p_margem,
              'deixou_de_ser_rentavel', c.deixou_de_ser_rentavel,
              'prejuizo', c.prejuizo,
              'frete_tirou_margem', c.frete_tirou_margem
            )
          ) as j
        from classificado c
        join public.ml_accounts a on a.id = c.ml_account_id
        left join mudanca m on m.chave = c.chave
        where c.total > 0
        order by c.total desc, (c.frete_soma_atual - c.referencia * c.n_atual) desc nulls last, c.chave
        limit 200
      ) x
    )
  )
  );
end;
$$;

comment on function public.get_detector_frete(uuid, date) is
  'D-397: anúncios com frete possivelmente errado -- histórico, irmãos do mesmo SKU, pares de categoria e faixa, proporção do preço e margem. Janelas de 14 e 76 dias até ontem.';

revoke all on function public.get_detector_frete(uuid, date) from public, anon;
grant execute on function public.get_detector_frete(uuid, date) to authenticated, service_role;

-- O catálogo espelha docs/METRICS.md 5L (D-023).
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions,
   cancellation_treatment, timezone, definition_updated_on)
values
  ('nivel_anomalia_frete', 'Nível de anomalia de frete',
   'soma dos pontos de cinco sinais (histórico do anúncio, outros anúncios do mesmo SKU, pares da categoria do Mercado Livre na faixa de preço, frete ÷ preço contra o p95 da faixa, margem); 0 normal, 1-2 atenção, 3-4 provável problema, 5+ forte indício',
   'orders + order_financials.seller_shipping_cost + order_items + listings.category_id + custo de get_faturamento (D-356)', array['listing'],
   'Pedidos válidos de uma linha e uma unidade, com frete observado, fora do Flex; últimos 14 dias até ontem contra os 76 anteriores; anúncio com 3 pedidos ou mais nos 14 dias.',
   'Pedido sem frete observado (não vira zero), Flex (self_service), pedido com mais de uma unidade. Peso e dimensões: cadastrados em poucos SKUs, sem comparação.',
   'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('frete_excedente_estimado', 'Frete a mais estimado (14 dias)',
   'Σ frete dos pedidos dos últimos 14 dias − referência × pedidos; referência = frete de antes do anúncio, dos outros anúncios do mesmo SKU ou dos pares, a primeira que pontuou; somado nos alertas provável e forte',
   'get_detector_frete', array['listing', 'organization'],
   'Só alertas com referência de frete (histórico, mesmo SKU ou pares).',
   'Alerta só por proporção ou margem: sem referência, sem excedente (NULL, nunca 0).',
   'excluded', 'America/Sao_Paulo', date '2026-09-23');
