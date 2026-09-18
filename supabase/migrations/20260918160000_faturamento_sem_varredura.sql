-- ============================================================
-- `get_faturamento` (D-356): o custo do produto sai de UMA leitura por SKU,
-- e nao de tres buscas por item. Mesmos valores; a ordem entre empatados
-- nas listas passa a ser por sku_id (e por conta em `por_conta`) -- item 5.
--
-- ------------------------------------------------------------
-- O QUE A AUDITORIA DISSE, E O QUE A MEDICAO MOSTROU
-- ------------------------------------------------------------
--
-- A auditoria de 18/09 leu "+331 mil seq_tup_read em orders e order_items"
-- numa chamada de 7 dias e concluiu varredura total. Remedido em PRODUCAO
-- como `authenticated` real (pg_stat_user_tables antes e depois de UMA
-- chamada, 18/09 11:32): `seq_scan` e `seq_tup_read` das duas nao se mexeram;
-- `idx_scan` de order_items subiu 5.420. O delta da auditoria veio de outra
-- leitura no mesmo intervalo. O corpo antigo ja chegava a `orders` pelo
-- `orders_date_created_idx` e a `order_items` pela chave do pedido.
--
-- O custo era outro, e o EXPLAIN do corpo (plano generico, como a
-- `language sql` planeja) mostra onde, em 30 dias (27.880 pedidos):
--
--     orders pela data                        27 mil buffers
--     order_items, uma busca por pedido      112 mil
--     skus, uma busca por ITEM                66 mil
--     sku_cost_history, uma por item          47 mil
--     sku_components + skus + historico       61 mil  (o kit, por item)
--     order_financials, uma busca por pedido  65 mil  (tabela de 117 paginas)
--     total                                  377 mil, e 19 MB de temp
--
-- Quase dois tercos (238 mil) eram o LATERAL de custo e o frete, buscados
-- item a item em tabelas que cabem inteiras em memoria.
--
-- ------------------------------------------------------------
-- O QUE MUDA
-- ------------------------------------------------------------
--
-- 1. CUSTO POR SKU, UMA VEZ. `historico` le `sku_cost_history` so dos SKUs
--    que aparecem na janela (e dos componentes dos kits deles) e transforma
--    cada linha num intervalo [changed_at, proxima changed_at). O item acha o
--    seu por hash join em `sku_id` + o filtro do intervalo. E o mesmo "ultimo
--    new_cost com changed_at <= date_created" de antes: o intervalo que
--    contem a data da venda e exatamente o da ultima mudanca ate ela. Antes
--    da primeira mudanca nao ha intervalo, e o item cai no `purchase_cost`
--    atual, como antes. Kit: os componentes entram pelo mesmo caminho, e o
--    agregado por item repete as expressoes de antes (`count`, `bool_and`,
--    `sum`), inclusive o `bool_and` que ignora fonte nula.
--
--    Empate de `changed_at` no mesmo SKU: o intervalo vazio [t, t) nunca
--    casa, e vence o de MAIOR `id` -- a gravacao mais recente. O corpo antigo
--    tomava "o primeiro" de um `order by changed_at desc limit 1`, sem
--    desempate: escolha do plano. Em producao, 18/09: zero empates.
--
-- 2. FRETE E DESCONTO PELO PEDIDO. O corpo antigo levava o frete so para a
--    primeira linha de cada pedido (`row_number()`) e depois tirava o `max`;
--    agora o pedido e agregado primeiro e o `order_financials` entra uma vez,
--    por hash. Mesmo valor: o `max` de um valor e NULLs e o valor. `itens`
--    vira `count(*)` do grupo, que e o `count(*) over (partition by pedido)`
--    de antes. Sem as duas janelas, sai o sort externo.
--
-- 3. `order_items` CONTINUA pela chave do pedido, e o `offset 0` garante.
--    Com a estimativa certa (plano custom, item 4), o planejador PREFERE
--    varrer `order_items` inteira (331 mil linhas) em hash join -- medido:
--    7 mil paginas lidas do disco, 2,1 s com cache frio. O `offset 0` no
--    LATERAL impede a subconsulta de virar join comum: a busca e por pedido,
--    proporcional a janela, sempre.
--
-- 4. `plpgsql` + `plan_cache_mode = force_custom_plan` (D-305/D-319): o
--    corpo e planejado com as datas de verdade a cada chamada (~8 ms de
--    planejamento em 30 dias). Oito execucoes seguidas na mesma sessao, no
--    Dev: 535, 495, 495, 497, 493, 497, 493, 491 ms -- sem salto na sexta.
--
-- 5. DESEMPATE NAS LISTAS. `maior_receita` e `menor_margem` ordenavam so
--    pela receita (ou margem + receita coberta) antes do `limit`, e
--    `por_conta` so pela receita. Heapsort top-N e quicksort nao sao
--    estaveis: entre dois SKUs com a mesma receita, a ordem -- e quem entra
--    no corte de 30 ou de 20 -- era escolha do plano, e a troca de plano
--    generico por custom (item 4) podia muda-la. Visto em producao, 18/09:
--    empate real em 178,27 nas posicoes 28-29. Agora `sku_id` (e
--    `ml_account_id` em `por_conta`) fecha a ordem.
--
-- 6. SO OS INTERVALOS QUE CRUZAM A JANELA. Sem filtro, cada item era
--    comparado com TODAS as mudancas do seu SKU (hash por sku_id + o filtro
--    do intervalo): O(itens x mudancas por SKU). Hoje nao pesa (uma linha
--    por SKU), mas cresce com o historico. Depois do `lead()`, `historico`
--    guarda so `desde < ts_to and (ate is null or ate > ts_from)`: toda venda
--    da janela cai num intervalo assim, e os outros nunca casariam. Medido
--    no Dev (corpo com literais, antes e depois do filtro, como postgres,
--    transacao desfeita) com 52 mudancas semanais por SKU, 30 dias: linhas
--    descartadas no filtro do intervalo 1.307.691 -> 115.251 (itens) e
--    112.302 -> 9.734 (kits), 885-903 -> 734-749 ms, os mesmos 147 mil
--    buffers. A leitura e a ordenacao do historico dos SKUs da janela ficam.
--
-- Tentado e DESCARTADO: passar os pedidos da janela como array constante
-- para ler `order_items` por `= any(...)` em bitmap (4,5 mil buffers em vez
-- de 112 mil). A juncao do array com `order_items` sai estimada em 1 linha
-- (o array nao tem estatistica), o resto do plano vira nested loop sobre
-- CTE, e a chamada estourou 120 s no Dev.
--
-- ------------------------------------------------------------
-- MEDIDO (producao, `authenticated`, ADMIN real, transacao desfeita)
-- ------------------------------------------------------------
--
-- Corpo sem os itens 5 e 6 (o 6 esta medido acima; o 5 so acrescenta uma
-- coluna as ordenacoes das listas):
--
--                       buffers            temp escrito      tempo
--     7 dias        83.861 -> 29.636        31 ->   0     195-197 -> 155-168 ms
--     30 dias      382.748 -> 140.370     2.409 -> 735    740-1.094 -> 538 ms
--     30d resumo   379.173 -> 139.866     2.409 -> 734    680-717 -> 432 ms
--
-- Numeros, planos e a prova completa: docs/PERFORMANCE.md.
--
-- ------------------------------------------------------------
-- OS VALORES NAO MUDAM; A ORDEM DOS EMPATADOS PODE MUDAR -- CONFERIDO
-- ------------------------------------------------------------
--
-- Sem os itens 5 e 6, em PRODUCAO, a funcao atual contra este corpo com os
-- parametros como literais, na mesma instrucao (mesmo snapshot): `jsonb`
-- igual E texto igual (md5 do `::text`), em 7 dias, 30 dias, 90 dias, agosto
-- inteiro, a conta GMR em 30 dias, `p_detalhe = false` em 30 dias e GMR +
-- agosto + resumo.
--
-- Com o desempate (item 5), a revisao de 18/09 comparou em producao 09/09 na
-- conta loja 1: `jsonb` e texto diferentes, e IGUAIS depois de ordenar as
-- listas pela ordem nova -- so a ordem dos empatados em `maior_receita`
-- mudou. Um empate em cima do corte (posicao 30 ou 20) tambem decide quem
-- entra na lista: antes, o plano; agora, o `sku_id`.
--
-- O historico de custo de producao tem UMA linha por SKU (gravadas em
-- 14/09), entao o caso "mudou de custo no meio da janela" nao aparece la.
-- Foi provado no Dev com o corpo FINAL (itens 1 a 6) criado em `pg_temp`,
-- contra a funcao atual, numa transacao desfeita: 22.321 linhas sinteticas
-- de historico em 1.762 SKUs (mudanca antes, dentro e depois da janela,
-- custo 0, custo NULL), mudanca no instante exato de 40 vendas, 30 pedidos
-- com dois itens e componentes de kit. Em 7d, 30d, 90d, fevereiro (todo o
-- historico depois da janela), um dia, uma conta e resumo, campo a campo
-- (resumo, diario, por_conta, as duas listas e as contagens): `jsonb` e
-- texto identicos, com e sem ordenar as listas.
--
-- ------------------------------------------------------------
-- A VOLTA
-- ------------------------------------------------------------
--
-- A assinatura e o retorno nao mudam, entao a volta e reaplicar DOIS
-- comandos de 20260915210100_faturamento_rpc.sql (o corpo que estava em
-- producao em 18/09: md5 do prosrc d1bf929b7752789f5d01004ee474bc72):
--
--   1. o `create or replace function public.get_faturamento(...)`, que troca
--      o corpo, a `language` e os SETs (os grants ficam);
--   2. o `comment on function public.get_faturamento(...)` logo abaixo dele.
--      O `create or replace` NAO mexe no comentario, e o que ficaria e o
--      deste arquivo, que descreve plpgsql e plano custom.
--
-- Nao reaplicar o arquivo inteiro: ele tambem faz upsert em
-- `metric_definitions`.
-- ============================================================

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
    group by l.order_id, l.ml_account_id, l.date_created, l.pack_id
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
      (f.seller_shipping_cost is not null and p.comissao_ok) as com_custos,
      (f.seller_shipping_cost is not null and p.comissao_ok and p.custo_ok and p.itens = 1) as coberto
    from por_pedido p
    left join public.order_financials f on f.order_id = p.order_id
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
      'pedidos_multi_item', count(*) filter (where k.itens > 1)
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
            and b.margem_venda < 0.10
          order by b.margem_venda, b.receita_coberta desc, b.sku_id
          limit 20
        ) x
      ),
      'skus_com_venda', (select count(*) from por_sku_base),
      'skus_margem_abaixo_10', (select count(*) from por_sku_base where pedidos_cobertos > 0 and margem_venda < 0.10),
      'skus_margem_negativa', (select count(*) from por_sku_base where pedidos_cobertos > 0 and margem_venda < 0)
    ) as j
  )
  select jsonb_build_object(
    'resumo', r.j,
    'diario', case when p_detalhe then d.j end,
    'por_conta', case when p_detalhe then c.j end,
    'por_sku', case when p_detalhe then s.j end
  )
  from resumo r, diario d, por_conta c, por_sku s
  );
end;
$$;

comment on function public.get_faturamento(date, date, uuid, boolean) is
  'Faturamento de um periodo (D-356): receita, comissao (sale_fee * quantity), frete do vendedor (o desconto e informativo: ja esta no preco), custo do produto na data da venda (kit = soma dos componentes) e margem, numa passada so. Resultado e margem SO sobre pedidos cobertos (frete observado, custo conhecido, uma linha de item), com a cobertura devolvida junto; o que nao e observado volta NULL, nunca zero. Nao e lucro liquido: impostos, taxa fixa, parcelamento, custo do Mercado Pago, reembolsos e Ads ficam fora. p_detalhe = false devolve so o resumo. Desde 18/09/2026: plpgsql com plano custom, order_items por pedido e o custo por SKU numa CTE de intervalos (em vez de tres buscas por item). security invoker.';

revoke all on function public.get_faturamento(date, date, uuid, boolean) from public, anon;
grant execute on function public.get_faturamento(date, date, uuid, boolean) to authenticated, service_role;
