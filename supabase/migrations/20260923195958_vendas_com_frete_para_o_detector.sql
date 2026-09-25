-- D-409 — O detector de frete lê uma tabela estreita de vendas, mantida por
-- gatilhos, em vez de juntar pedidos, fretes e itens de 90 dias a cada chamada.
--
-- Medido em produção em 25/09/2026, como `EXPLAIN (ANALYZE, BUFFERS)` só de
-- leitura, a parte do detector que junta `orders`, `order_financials` e
-- `order_items` dos 90 dias: 78.208 pedidos, 77.143 linhas elegíveis,
-- 626 ms com TUDO em cache e 387.963 páginas tocadas -- cada pedido numa
-- página de `orders` diferente (74 mil páginas para 79 mil linhas) e cada
-- item mais quatro (313 mil). A frio isso vira leitura de disco: o detector
-- fez 4,4 s na primeira chamada (D-399) e, dentro da sincronização dos
-- alertas das 8h de 25/09, 9,7 s -- acima do `statement_timeout` de 8 s; a
-- repetição do Cloud Tasks passou em 2,4 s.
--
-- `shipping_sales` guarda UMA linha por venda que o detector considera: um
-- item só, quantidade 1, paga ou parcialmente reembolsada, fora do Flex
-- (`self_service`), com o frete do vendedor capturado. ~100 bytes por linha:
-- os 90 dias cabem em ~1 mil páginas lidas em sequência.
--
-- GATILHOS, NÃO ROTINA DIÁRIA. Quem grava `orders`, `order_items` e
-- `order_financials` é o worker; cada mudança que muda a elegibilidade ou os
-- números de uma venda (o frete capturado, o status, a logística, o SKU
-- vinculado, uma segunda linha no pedido) recalcula a linha daquele pedido
-- com a regra de sempre. O detector continua vendo o mesmo que via ao ler as
-- três tabelas, no mesmo instante -- sem janela de atraso nem job novo.
--
-- O custo do produto continua sendo calculado na leitura, pelas CTEs de
-- `get_faturamento` (D-356): o custo atual pode mudar, e congelá-lo aqui
-- faria o detector divergir do faturamento.

create table public.shipping_sales (
  order_id bigint primary key references public.orders(id) on delete cascade,
  organization_id uuid not null,
  ml_account_id uuid not null,
  date_created timestamptz not null,
  line_id uuid not null,
  listing_id text not null,
  sku_id uuid,
  title text,
  unit_price numeric not null,
  sale_fee numeric,
  shipping_cost numeric not null
);

create index shipping_sales_org_date_idx on public.shipping_sales (organization_id, date_created);

alter table public.shipping_sales enable row level security;

-- O mesmo alcance de `orders`: quem alcança a CONTA lê (forma de conjunto,
-- D-181). Ninguém grava direto: só os gatilhos abaixo.
create policy shipping_sales_select_permitted
  on public.shipping_sales for select to authenticated
  using (ml_account_id in (select private.accessible_accounts()));

revoke all on public.shipping_sales from anon, authenticated, service_role;
grant select on public.shipping_sales to authenticated;
grant select on public.shipping_sales to service_role;

comment on table public.shipping_sales is
  'Vendas que o detector de frete considera (D-409): uma linha por pedido de um item só, quantidade 1, pago ou parcialmente reembolsado, fora do Flex, com o frete do vendedor capturado. Mantida por gatilhos em orders, order_items e order_financials; só leitura para todos. Existe para o detector ler ~1 mil páginas em sequência em vez de ~390 mil espalhadas.';

-- A linha de UM pedido, recalculada pela regra das CTEs `pedidos` e `linhas`
-- de D-397. Apaga e regrava: sem a venda elegível, fica sem linha.
create or replace function private.sync_shipping_sale(p_order_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.shipping_sales where order_id = p_order_id;

  insert into public.shipping_sales
    (order_id, organization_id, ml_account_id, date_created, line_id, listing_id, sku_id, title,
     unit_price, sale_fee, shipping_cost)
  select o.id, o.organization_id, o.ml_account_id, o.date_created, i.id, i.item_id, i.sku_id, i.title,
         i.unit_price, i.sale_fee, f.seller_shipping_cost
  from public.orders o
  join public.order_financials f on f.order_id = o.id
  join public.order_items i
    on i.order_id = o.id
   and i.organization_id = o.organization_id
   and i.ml_account_id = o.ml_account_id
  where o.id = p_order_id
    and o.status in ('paid', 'partially_refunded')
    and o.logistic_type is distinct from 'self_service'
    and f.seller_shipping_cost is not null
    and i.quantity = 1
    and (
      select count(*)
      from public.order_items c
      where c.order_id = o.id
        and c.organization_id = o.organization_id
        and c.ml_account_id = o.ml_account_id
    ) = 1;
end;
$$;

create or replace function private.shipping_sales_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'orders' then
    perform private.sync_shipping_sale(new.id);
  else
    if tg_op in ('UPDATE', 'DELETE') then
      perform private.sync_shipping_sale(old.order_id);
    end if;

    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.order_id is distinct from old.order_id) then
      perform private.sync_shipping_sale(new.order_id);
    end if;
  end if;

  return null;
end;
$$;

-- Nada disto é chamável de fora: só os gatilhos.
revoke all on function private.sync_shipping_sale(bigint) from public, anon, authenticated, service_role;
revoke all on function private.shipping_sales_trigger() from public, anon, authenticated, service_role;

-- O frete capturado (ou apagado) muda a elegibilidade.
create trigger shipping_sales_from_financials
  after insert or update of seller_shipping_cost or delete on public.order_financials
  for each row execute function private.shipping_sales_trigger();

-- O pedido: só quando muda o que a regra lê. O webhook regrava `orders` o
-- tempo todo com os mesmos valores, e isso não pode custar nada.
create trigger shipping_sales_from_orders
  after update on public.orders
  for each row
  when (
    old.status is distinct from new.status
    or old.logistic_type is distinct from new.logistic_type
    or old.date_created is distinct from new.date_created
    or old.organization_id is distinct from new.organization_id
    or old.ml_account_id is distinct from new.ml_account_id
  )
  execute function private.shipping_sales_trigger();

-- Os itens: linha nova ou apagada muda a contagem; na atualização, só o que
-- a regra e o detector leem.
create trigger shipping_sales_from_items_insert_delete
  after insert or delete on public.order_items
  for each row execute function private.shipping_sales_trigger();

create trigger shipping_sales_from_items_update
  after update on public.order_items
  for each row
  when (
    old.order_id is distinct from new.order_id
    or old.organization_id is distinct from new.organization_id
    or old.ml_account_id is distinct from new.ml_account_id
    or old.item_id is distinct from new.item_id
    or old.sku_id is distinct from new.sku_id
    or old.title is distinct from new.title
    or old.quantity is distinct from new.quantity
    or old.unit_price is distinct from new.unit_price
    or old.sale_fee is distinct from new.sale_fee
  )
  execute function private.shipping_sales_trigger();

-- O histórico que já existe, pela mesma regra, numa passada só.
insert into public.shipping_sales
  (order_id, organization_id, ml_account_id, date_created, line_id, listing_id, sku_id, title,
   unit_price, sale_fee, shipping_cost)
select o.id, o.organization_id, o.ml_account_id, o.date_created, i.id, i.item_id, i.sku_id, i.title,
       i.unit_price, i.sale_fee, f.seller_shipping_cost
from public.orders o
join public.order_financials f on f.order_id = o.id
join public.order_items i
  on i.order_id = o.id
 and i.organization_id = o.organization_id
 and i.ml_account_id = o.ml_account_id
where o.status in ('paid', 'partially_refunded')
  and o.logistic_type is distinct from 'self_service'
  and f.seller_shipping_cost is not null
  and i.quantity = 1
  and not exists (
    select 1
    from public.order_items c
    where c.order_id = o.id
      and c.organization_id = o.organization_id
      and c.ml_account_id = o.ml_account_id
      and c.id <> i.id
  );

-- Estatísticas ANTES de o detector novo planejar a primeira leitura. Medido
-- no ensaio do Dev (25/09): com a tabela recém-preenchida e sem `analyze`, o
-- planejador escolheu junções ruins e a chamada passou de 3,5 minutos; com
-- ele, 155 ms -- contra ~310 ms do detector que lia as três tabelas.
analyze public.shipping_sales;

-- O detector de D-397/D-399, lendo `shipping_sales`. Só as duas primeiras
-- CTEs mudaram.
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
  -- D-409: as vendas de um item só, com frete capturado, vêm de
  -- `shipping_sales`, mantida por gatilhos com a MESMA regra que as CTEs
  -- `pedidos` e `linhas` aplicavam lendo `orders`, `order_financials` e
  -- `order_items` pedido a pedido -- 79 mil pedidos em páginas espalhadas.
  -- `item_id` continua sendo o id da LINHA (as CTEs de custo abaixo são as de
  -- `get_faturamento`, sem mudança); o anúncio é `anuncio`.
  with linhas as materialized (
    select
      s.order_id,
      s.ml_account_id,
      s.date_created,
      s.shipping_cost as frete,
      s.line_id as item_id,
      s.listing_id as anuncio,
      s.sku_id,
      s.title,
      1 as quantity,
      s.unit_price as preco,
      s.sale_fee as comissao
    from public.shipping_sales s
    where s.organization_id = p_organization_id
      and s.date_created >= v_ini
      and s.date_created < v_fim
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
  -- D-399: a mudança GERAL do frete em cada faixa = a mediana da variação dos
  -- anúncios que venderam nas duas janelas (frete de agora ÷ frete de antes).
  -- Se a tabela do Mercado Livre subiu 5%, a maioria dos anúncios mostra 1,05;
  -- o que é de um anúncio só fica fora da mediana. NÃO é a mediana de todos os
  -- pedidos: ela muda com a composição (medido: +24% na faixa de R$ 200 a 400
  -- porque passou a vender mais baú, contra +3,1% pelos anúncios). Com menos de
  -- 10 anúncios comparáveis na faixa, não há mudança medida (fator 1).
  fator as (
    select
      a.faixa,
      count(*) as anuncios_comparados,
      case
        when count(*) >= 10
        then percentile_cont(0.5) within group (order by a.frete_atual / a.frete_antes)
      end as fator_geral
    from anuncios a
    where a.n_antes >= 5
      and a.frete_antes > 0
    group by a.faixa
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
      fg.fator_geral,
      a.frete_antes * coalesce(fg.fator_geral, 1) as frete_esperado,
      a.frete_atual / nullif(a.preco_atual, 0) as razao,
      greatest(0.15, 3 * coalesce(a.mad_antes, 0) / nullif(a.frete_antes, 0)) as limiar_historico,
      a.frete_atual / nullif(a.frete_antes * coalesce(fg.fator_geral, 1), 0) - 1 as var_historico,
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
    left join fator fg on fg.faixa = a.faixa
  ),
  pontos as (
    select
      m.*,
      case
        when m.n_antes >= 5 and m.frete_antes > 0
             and m.frete_atual - m.frete_esperado >= 1 then
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
        when z.p_historico > 0 then z.frete_esperado
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
        'razao_p95', round(f.razao_p95::numeric, 4),
        'anuncios_comparados', coalesce(fg.anuncios_comparados, 0),
        'variacao_geral', round((fg.fator_geral - 1)::numeric, 4)
      ) order by f.faixa), '[]'::jsonb)
      from faixas f
      left join fator fg on fg.faixa = f.faixa
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
            'frete_esperado', round(c.frete_esperado::numeric, 2),
            'variacao_geral_faixa', round((c.fator_geral - 1)::numeric, 4),
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
