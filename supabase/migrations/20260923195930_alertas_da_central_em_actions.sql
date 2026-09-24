-- D-403 — A central de alertas persistida em `actions`.
--
-- "O que precisa da sua atenção" (D-400) é calculado a cada leitura: diz
-- quantos, não guarda nada. O pedido do dono (D-394, seções 13, 14 e 18) quer
-- clicar no alerta e abrir o problema, e a trilha 5J quer histórico e
-- "resolvido". Esta migration grava, uma vez por dia e por organização, um
-- item da Central de Ações por assunto:
--
--   frete_anomalo     anúncio × faixa com provável problema ou forte indício
--                     de frete (get_detector_frete, D-397/D-399);
--   ads_campanha      campanha crítica ou com ROAS abaixo de 80% da meta na
--                     semana consolidada (get_sinais_ads, D-398/D-401);
--   produto_prejuizo  SKU que fechou no prejuízo nos 30 dias até ontem, com
--                     3 pedidos cobertos ou mais (get_ranking_produtos, D-402).
--
-- Nenhum detector novo: os três já existem e são os mesmos da tela.
--
-- O CICLO DE VIDA (um episódio por assunto):
--   - aberto e detectado hoje: evidência, severidade e impacto de hoje;
--   - fechado por uma pessoa e ainda detectado: não reabre, só anota que
--     continua (quem resolveu já decidiu);
--   - 3 dias sem detecção numa fonte que rodou: o sistema encerra e diz por quê;
--   - detectado de novo depois disso: episódio novo, linha nova.
-- `dedup_key` = tipo:assunto:dia em que o episódio nasceu; o índice parcial
-- garante no banco um só episódio aberto por assunto.
--
-- A notificação fica para a fatia seguinte: `domain_events` exige conta, e o
-- alerta de produto é da organização.

-- ─── 1. actions: o assunto e a última detecção ─────────────────────────────
alter table public.actions
  add column subject_key text,
  add column last_detected_on date;

comment on column public.actions.subject_key is
  'D-403: o assunto do alerta (anúncio:faixa, conta:campanha, sku_id), para achar o episódio. NULL nos tipos anteriores, que têm um episódio por dedup_key.';
comment on column public.actions.last_detected_on is
  'D-403: o último dia em que a condição foi detectada. Três dias sem detecção encerram o episódio aberto.';

create unique index actions_um_episodio_aberto
  on public.actions (organization_id, kind, subject_key)
  where subject_key is not null and status in ('novo', 'em_andamento');

create index actions_assunto_idx
  on public.actions (organization_id, kind, subject_key, last_detected_on desc)
  where subject_key is not null;

-- ─── 2. get_ranking_produtos: o recorte por organização ────────────────────
-- A sincronização roda como service_role, sem RLS: sem este argumento, o
-- ranking somaria todas as organizações. A tela não passa o argumento e
-- continua recortada pelo RLS.
drop function public.get_ranking_produtos(date, date, uuid, text, integer, integer, date, date);

create or replace function public.get_ranking_produtos(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_ordem text default 'receita',
  p_limite integer default 50,
  p_offset integer default 0,
  p_anterior_from date default null,
  p_anterior_to date default null,
  p_organization_id uuid default null
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
      -- D-403: a sincronização de alertas roda como service_role, sem RLS.
      and (p_organization_id is null or o.organization_id = p_organization_id)
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

comment on function public.get_ranking_produtos(date, date, uuid, text, integer, integer, date, date, uuid) is
  'D-402: ranking de produtos do periodo contra um periodo anterior (por padrao o de mesmo tamanho logo antes) -- receita, lucro (resultado da venda), maior e menor margem, volume, frete, prejuizo, crescimento e queda de margem. Custos de get_faturamento (D-356/D-395) numa passada so pelos dois periodos; resultado e margem so sobre pedidos cobertos, NULL quando nao observado. Ads por produto nao existe na API. Pagina de ate 100. security invoker; p_organization_id (D-403) recorta quando quem chama e o service_role, sem RLS.';

revoke all on function public.get_ranking_produtos(date, date, uuid, text, integer, integer, date, date, uuid) from public, anon;
grant execute on function public.get_ranking_produtos(date, date, uuid, text, integer, integer, date, date, uuid) to authenticated, service_role;

-- ─── 3. Os números no texto da evidência ───────────────────────────────────
-- A evidência de `actions` é texto pronto (D-064): a tela e a narração leem
-- `evidencias[].descricao` sem saber o `kind`. O separador é fixo -- `to_char`
-- com G/D seguiria o locale do servidor.
create or replace function private.formatar_brl(p_valor numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_valor is null then '—'
    else (case when p_valor < 0 then '-' else '' end)
      || 'R$ ' || translate(to_char(abs(round(p_valor, 2)), 'FM999,999,999,990.00'), ',.', '.,')
  end
$$;

create or replace function private.formatar_pct(p_fracao numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_fracao is null then '—'
    else replace(to_char(round(p_fracao * 100, 1), 'FM999990.0'), '.', ',') || '%'
  end
$$;

revoke all on function private.formatar_brl(numeric) from public;
revoke all on function private.formatar_pct(numeric) from public;
grant execute on function private.formatar_brl(numeric) to service_role;
grant execute on function private.formatar_pct(numeric) to service_role;

-- ─── 4. A sincronização ─────────────────────────────────────────────────────
create or replace function public.sincronizar_alertas_central(
  p_organization_id uuid,
  p_hoje date default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_hoje date := coalesce(p_hoje, (now() at time zone 'America/Sao_Paulo')::date);
  v_frete jsonb;
  v_ads jsonb;
  v_pagina jsonb;
  v_offset integer := 0;
  v_total integer;
  v_fontes text[] := '{}';
  v_detectado jsonb := '[]'::jsonb;
  v_atualizadas integer := 0;
  v_continuas integer := 0;
  v_criadas integer := 0;
  v_encerradas integer := 0;
begin
  if p_organization_id is null then
    raise exception 'organizacao obrigatoria' using errcode = '22023';
  end if;

  -- 4.1 Frete: provável problema e forte indício (D-397/D-399). A fonte só
  -- conta como "rodou" com anúncio analisado: sem frete observado, nada é
  -- encerrado por ausência.
  v_frete := public.get_detector_frete(p_organization_id, v_hoje);

  if coalesce((v_frete -> 'resumo' ->> 'analisados')::integer, 0) > 0 then
    v_fontes := array_append(v_fontes, 'frete_anomalo');
    v_detectado := v_detectado || coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', 'frete_anomalo',
        'subject_key', (a ->> 'anuncio') || ':' || (a ->> 'faixa'),
        'severity', case a ->> 'nivel' when 'forte' then 'alta' else 'media' end,
        'confidence', case a ->> 'nivel' when 'forte' then 'alta' else 'media' end,
        'impacto', case when (a ->> 'excesso')::numeric > 0 then (a ->> 'excesso')::numeric end,
        'ml_account_id', (
          select l.ml_account_id
          from public.listings l
          where l.organization_id = p_organization_id
            and l.item_id = a ->> 'anuncio'
          limit 1
        ),
        'sku_id', a ->> 'sku_id',
        'mlb_id', a ->> 'anuncio',
        'evidence', jsonb_build_object(
          'nivel', a ->> 'nivel',
          'pontos', (a ->> 'pontos')::integer,
          'faixa', a ->> 'faixa',
          'evidencias', jsonb_path_query_array(jsonb_build_array(
            jsonb_build_object('tipo', 'frete_atual', 'descricao', format(
              'Frete médio de %s nos últimos 14 dias até %s (%s pedidos, preço %s).',
              private.formatar_brl((a ->> 'frete_atual')::numeric),
              to_char(v_hoje - 1, 'DD/MM/YYYY'),
              a ->> 'pedidos_atual',
              case a ->> 'faixa'
                when 'ate_40' then 'até R$ 40'
                when '40_79' then 'de R$ 40 a R$ 79'
                when '79_120' then 'de R$ 79 a R$ 120'
                when '120_200' then 'de R$ 120 a R$ 200'
                when '200_400' then 'de R$ 200 a R$ 400'
                else 'acima de R$ 400'
              end)),
            case when a ->> 'frete_esperado' is not null then jsonb_build_object('tipo', 'historico', 'descricao', format(
              'Pelo histórico do próprio anúncio, o esperado seria %s.', private.formatar_brl((a ->> 'frete_esperado')::numeric))) end,
            case when a ->> 'frete_irmaos' is not null then jsonb_build_object('tipo', 'mesmo_produto', 'descricao', format(
              'Outros anúncios do mesmo produto pagam %s.', private.formatar_brl((a ->> 'frete_irmaos')::numeric))) end,
            case when a ->> 'frete_pares' is not null then jsonb_build_object('tipo', 'pares', 'descricao', format(
              'Produtos da mesma categoria na faixa pagam %s (%s produtos).',
              private.formatar_brl((a ->> 'frete_pares')::numeric), a ->> 'pares')) end,
            jsonb_build_object('tipo', 'nivel', 'descricao', format(
              '%s (%s pontos no detector de frete).',
              case a ->> 'nivel' when 'forte' then 'Forte indício de frete errado' else 'Provável problema de frete' end,
              a ->> 'pontos'))
          ), '$[*] ? (@ != null)'),
          -- O retrato do detector no dia, para o histórico do episódio.
          'detector', a
        ),
        'recommendation', case a ->> 'nivel'
          when 'forte' then 'Vale conferir o peso e as medidas cadastrados no anúncio e a etiqueta dos últimos envios: o frete destoa em mais de uma comparação. O motivo completo está no detector de frete.'
          else 'Vale conferir o cadastro de peso e medidas do anúncio antes que o frete a mais se acumule. O motivo completo está no detector de frete.'
        end
      ))
      from jsonb_array_elements(v_frete -> 'alertas') a
      where a ->> 'nivel' in ('provavel', 'forte')
    ), '[]'::jsonb);
  end if;

  -- 4.2 Ads: crítico e ROAS abaixo da meta, na semana consolidada (D-398/
  -- D-401). Sem semana consolidada, a fonte não rodou.
  v_ads := public.get_sinais_ads(p_organization_id, v_hoje);

  if v_ads -> 'janela' ->> 'fim' is not null then
    v_fontes := array_append(v_fontes, 'ads_campanha');
    v_detectado := v_detectado || coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', 'ads_campanha',
        'subject_key', (c ->> 'ml_account_id') || ':' || (c ->> 'campaign_id'),
        'severity', case c ->> 'nivel' when 'critico' then 'alta' else 'media' end,
        'confidence', 'alta',
        -- Gasto além do que a meta da própria campanha pediria para a mesma
        -- venda; sem meta, o que não voltou em venda.
        'impacto', case
          when (c ->> 'roas_alvo')::numeric > 0
            then nullif(greatest(round((c ->> 'investimento')::numeric - (c ->> 'receita_ads')::numeric / (c ->> 'roas_alvo')::numeric, 2), 0), 0)
          else nullif(greatest((c ->> 'investimento')::numeric - (c ->> 'receita_ads')::numeric, 0), 0)
        end,
        'ml_account_id', c ->> 'ml_account_id',
        'sku_id', null,
        'mlb_id', null,
        'evidence', jsonb_build_object(
          'nivel', c ->> 'nivel',
          'campanha', c ->> 'nome',
          'campaign_id', (c ->> 'campaign_id')::bigint,
          'conta', c ->> 'conta',
          'evidencias', jsonb_path_query_array(jsonb_build_array(
            jsonb_build_object('tipo', 'semana', 'descricao', format(
              'Campanha "%s" (%s), semana de %s a %s: %s investidos e %s em vendas atribuídas (%s unidades).',
              c ->> 'nome', c ->> 'conta',
              to_char((v_ads -> 'janela' ->> 'inicio')::date, 'DD/MM/YYYY'),
              to_char((v_ads -> 'janela' ->> 'fim')::date, 'DD/MM/YYYY'),
              private.formatar_brl((c ->> 'investimento')::numeric),
              private.formatar_brl((c ->> 'receita_ads')::numeric),
              c ->> 'unidades')),
            case when c ->> 'roas' is not null then jsonb_build_object('tipo', 'roas', 'descricao', format(
              'ROAS %s%s.',
              replace(to_char((c ->> 'roas')::numeric, 'FM999990.00'), '.', ','),
              case when c ->> 'roas_alvo' is not null
                then ' contra a meta de ' || replace(to_char((c ->> 'roas_alvo')::numeric, 'FM999990.00'), '.', ',') || ' da campanha'
                else '' end)) end,
            case when c ->> 'roas_anterior' is not null then jsonb_build_object('tipo', 'anterior', 'descricao', format(
              'Na semana anterior: ROAS %s, com %s investidos.',
              replace(to_char((c ->> 'roas_anterior')::numeric, 'FM999990.00'), '.', ','),
              private.formatar_brl((c ->> 'investimento_anterior')::numeric))) end
          ), '$[*] ? (@ != null)'),
          'detector', c
        ),
        'recommendation', case
          when c ->> 'nivel' = 'critico' and (c ->> 'unidades')::integer = 0
            then 'Vale revisar a campanha: ela gastou sem vender na semana. Considere reduzir o orçamento e investigar segmentação e produtos; avaliar pausa caso o comportamento permaneça.'
          when c ->> 'nivel' = 'critico'
            then 'Vale revisar a campanha: o Ads custou mais do que vendeu na semana. Considere reduzir o orçamento enquanto investiga CPC, conversão e produtos.'
          else 'Vale revisar o que puxou o ROAS para baixo da meta — CPC, conversão ou produtos anunciados — antes de continuar investindo no mesmo ritmo.'
        end
      ))
      from jsonb_array_elements(v_ads -> 'campanhas') c
      where c ->> 'nivel' in ('critico', 'abaixo_meta')
    ), '[]'::jsonb);
  end if;

  -- 4.3 Produtos no prejuízo nos 30 dias completos até ontem (D-402), com 3
  -- pedidos cobertos ou mais: uma venda só no prejuízo é o ranking que mostra,
  -- não um alerta.
  loop
    v_pagina := public.get_ranking_produtos(
      p_date_from => v_hoje - 30,
      p_date_to => v_hoje - 1,
      p_ordem => 'prejuizo',
      p_limite => 100,
      p_offset => v_offset,
      p_organization_id => p_organization_id
    );

    if v_offset = 0 then
      exit when coalesce((v_pagina -> 'resumo' ->> 'skus_cobertos')::integer, 0) = 0;
      v_fontes := array_append(v_fontes, 'produto_prejuizo');
    end if;

    v_detectado := v_detectado || coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', 'produto_prejuizo',
        'subject_key', p ->> 'sku_id',
        'severity', case when (p ->> 'margem_venda')::numeric <= -0.10 then 'alta' else 'media' end,
        'confidence', case when (p ->> 'pedidos_cobertos')::integer >= 5 and not (p ->> 'custo_atual')::boolean then 'alta' else 'media' end,
        'impacto', -(p ->> 'resultado_venda')::numeric,
        'ml_account_id', null,
        'sku_id', p ->> 'sku_id',
        'mlb_id', null,
        'evidence', jsonb_build_object(
          'periodo', jsonb_build_object('inicio', v_hoje - 30, 'fim', v_hoje - 1),
          'evidencias', jsonb_path_query_array(jsonb_build_array(
            jsonb_build_object('tipo', 'resultado', 'descricao', format(
              'De %s a %s: %s pedidos cobertos, %s de receita e resultado de %s (margem %s).',
              to_char(v_hoje - 30, 'DD/MM/YYYY'), to_char(v_hoje - 1, 'DD/MM/YYYY'),
              p ->> 'pedidos_cobertos',
              private.formatar_brl((p ->> 'receita_coberta')::numeric),
              private.formatar_brl((p ->> 'resultado_venda')::numeric),
              private.formatar_pct((p ->> 'margem_venda')::numeric))),
            jsonb_build_object('tipo', 'custos', 'descricao', format(
              'Comissão %s, frete %s e custo do produto %s nos mesmos pedidos.',
              private.formatar_brl((p ->> 'taxas_ml_cobertas')::numeric),
              private.formatar_brl((p ->> 'frete_vendedor')::numeric),
              private.formatar_brl((p ->> 'custo_produtos')::numeric))),
            case when (p ->> 'custo_atual')::boolean then jsonb_build_object('tipo', 'custo_atual', 'descricao',
              'Parte dos pedidos usou o custo atual, por não haver histórico de custo anterior à venda.') end
          ), '$[*] ? (@ != null)'),
          'detector', p
        ),
        'recommendation', 'Vale revisar preço, custo e frete do produto: ele fechou no prejuízo no período. O ranking de produtos mostra a conta completa.'
      ))
      from jsonb_array_elements(v_pagina -> 'itens') p
      where (p ->> 'pedidos_cobertos')::integer >= 3
    ), '[]'::jsonb);

    v_total := (v_pagina ->> 'total')::integer;
    v_offset := v_offset + 100;
    exit when v_offset >= v_total;
  end loop;

  -- 5. O ciclo de vida. Um assunto (anúncio × faixa, campanha, SKU) tem um
  -- episódio por vez: `dedup_key` = tipo:assunto:dia em que o episódio nasceu.

  -- 5.1 Episódio aberto e ainda detectado: a evidência, a severidade e o
  -- impacto passam a ser os de hoje.
  with d as (
    select * from jsonb_to_recordset(v_detectado) as x(
      kind text, subject_key text, severity text, confidence text, impacto numeric,
      ml_account_id uuid, sku_id uuid, mlb_id text, evidence jsonb, recommendation text)
  )
  update public.actions a set
    severity = d.severity,
    confidence = d.confidence,
    estimated_impact_brl = d.impacto,
    ml_account_id = coalesce(d.ml_account_id, a.ml_account_id),
    sku_id = coalesce(d.sku_id, a.sku_id),
    mlb_id = coalesce(d.mlb_id, a.mlb_id),
    evidence = d.evidence || jsonb_build_object(
      'primeira_deteccao', coalesce(a.evidence -> 'primeira_deteccao', to_jsonb(a.created_at::date)),
      'ultima_deteccao', v_hoje),
    recommendation = d.recommendation,
    last_detected_on = v_hoje
  from d
  where a.organization_id = p_organization_id
    and a.kind = d.kind
    and a.subject_key = d.subject_key
    and a.status in ('novo', 'em_andamento');

  get diagnostics v_atualizadas = row_count;

  -- 5.2 Episódio fechado por uma pessoa, e a condição continua (detectada
  -- até anteontem): não reabre -- quem resolveu ou descartou já decidiu. Só a
  -- continuidade é anotada, para o episódio não recomeçar amanhã.
  with d as (
    select * from jsonb_to_recordset(v_detectado) as x(kind text, subject_key text)
  )
  update public.actions a set last_detected_on = v_hoje
  from d
  where a.organization_id = p_organization_id
    and a.kind = d.kind
    and a.subject_key = d.subject_key
    and a.status in ('resolvido', 'descartado')
    and a.last_detected_on >= v_hoje - 2
    and a.last_detected_on < v_hoje
    and not exists (
      select 1 from public.actions o
      where o.organization_id = a.organization_id
        and o.kind = a.kind
        and o.subject_key = a.subject_key
        and o.status in ('novo', 'em_andamento')
    );

  get diagnostics v_continuas = row_count;

  -- 5.3 Episódio novo: detectado hoje, sem episódio aberto e sem um fechado
  -- que ainda esteja em curso.
  with d as (
    select * from jsonb_to_recordset(v_detectado) as x(
      kind text, subject_key text, severity text, confidence text, impacto numeric,
      ml_account_id uuid, sku_id uuid, mlb_id text, evidence jsonb, recommendation text)
  )
  insert into public.actions (
    organization_id, kind, severity, confidence, estimated_impact_brl,
    ml_account_id, sku_id, mlb_id, evidence, recommendation,
    created_by, dedup_key, subject_key, last_detected_on)
  select
    p_organization_id, d.kind, d.severity, d.confidence, d.impacto,
    d.ml_account_id, d.sku_id, d.mlb_id,
    d.evidence || jsonb_build_object('primeira_deteccao', v_hoje, 'ultima_deteccao', v_hoje),
    d.recommendation,
    'system', d.kind || ':' || d.subject_key || ':' || to_char(v_hoje, 'YYYY-MM-DD'), d.subject_key, v_hoje
  from d
  where not exists (
    select 1 from public.actions a
    where a.organization_id = p_organization_id
      and a.kind = d.kind
      and a.subject_key = d.subject_key
      and (a.status in ('novo', 'em_andamento') or a.last_detected_on >= v_hoje - 2)
  )
  on conflict (organization_id, dedup_key) do nothing;

  get diagnostics v_criadas = row_count;

  -- 5.4 Episódio aberto que não aparece há 3 dias, numa fonte que rodou hoje:
  -- o sistema encerra, e diz por quê. Três dias, não um: um anúncio perto do
  -- limiar entra e sai do nível de um dia para o outro.
  update public.actions a set
    status = 'resolvido',
    evidence = a.evidence || jsonb_build_object('encerramento', jsonb_build_object(
      'em', v_hoje,
      'por', 'sistema',
      'motivo', case a.kind
        when 'frete_anomalo' then 'O detector de frete deixou de apontar o anúncio como provável problema há 3 dias: o frete voltou ao normal, o nível caiu ou faltam pedidos na janela de 14 dias.'
        when 'ads_campanha' then 'A campanha saiu do nível crítico e de ROAS abaixo da meta na semana consolidada há 3 dias, ou deixou de gastar.'
        else 'O produto não fecha mais no prejuízo nos 30 dias até ontem, ou deixou de ter 3 pedidos cobertos.'
      end))
  where a.organization_id = p_organization_id
    and a.kind = any(v_fontes)
    and a.subject_key is not null
    and a.status in ('novo', 'em_andamento')
    and a.last_detected_on <= v_hoje - 3;

  get diagnostics v_encerradas = row_count;

  return jsonb_build_object(
    'hoje', v_hoje,
    'fontes', to_jsonb(v_fontes),
    'detectados', (
      select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb)
      from (
        select x ->> 'kind' as kind, count(*) as n
        from jsonb_array_elements(v_detectado) x
        group by x ->> 'kind'
      ) k
    ),
    'atualizadas', v_atualizadas,
    'continuas', v_continuas,
    'criadas', v_criadas,
    'encerradas', v_encerradas
  );
end;
$$;

comment on function public.sincronizar_alertas_central(uuid, date) is
  'D-403: grava em actions os alertas da central -- frete provável/forte (get_detector_frete), campanha crítica/abaixo da meta (get_sinais_ads) e produto no prejuízo em 30 dias com 3 pedidos cobertos (get_ranking_produtos) -- um episódio por assunto: atualiza o aberto, respeita o fechado por uma pessoa enquanto a condição continua, abre um novo depois de 3 dias sem detecção, e encerra o aberto que sumiu há 3 dias numa fonte que rodou. Só o worker chama (service_role).';

revoke all on function public.sincronizar_alertas_central(uuid, date) from public, anon, authenticated;
grant execute on function public.sincronizar_alertas_central(uuid, date) to service_role;
