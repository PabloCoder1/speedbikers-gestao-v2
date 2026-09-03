-- ============================================================
-- `get_sku_sales_breakdown` -- a aba Vendas do Dashboard de SKU (D-227).
--
-- A unica das nove abas (D-224) que precisou de RPC propria: as outras tres
-- que faltavam sairam por reuso (Full, D-225; Precos, D-226). Aqui nao havia o
-- que reusar -- `get_sku_dashboard` devolve dois numeros (unidades e receita)
-- e nenhuma RPC entrega, no grao SKU, os outros quatro canonicos de
-- docs/METRICS.md 5.2: `pedidos`, `pedidos_por_pack`, `ticket_medio` e
-- `preco_medio_praticado`. Todos ja tem `sku` como granularidade aprovada em
-- `metric_definitions`; nenhuma metrica nova foi inventada.
--
-- ------------------------------------------------------------
-- POR QUE UMA FUNCAO SO, COM GROUPING SETS
-- ------------------------------------------------------------
-- A aba responde tres perguntas -- quanto vendeu no total, em que contas, em
-- que dias. Sao tres agrupamentos do MESMO conjunto de linhas (as de
-- `daily_sku_metrics` do SKU na janela). `group by grouping sets ((),
-- (conta), (dia))` calcula os tres numa varredura, e a coluna `grain` diz de
-- qual agrupamento cada linha veio. Uma chamada, um round trip: D-185 mediu
-- que o custo de uma chamada e a viagem, nao o SQL (SQL = 0,6%). Tres RPCs,
-- ou uma RPC de serie mais soma em JavaScript, seriam ou tres viagens ou a
-- agregacao no lugar proibido (docs/ARCHITECTURE.md secao 15).
--
-- As razoes (`average_ticket`, `average_selling_price`) sao calculadas sobre
-- as SOMAS de cada grupo, nunca media das razoes diarias -- a proibicao
-- expressa de docs/METRICS.md 5.1 ("media de medias"). Com denominador zero
-- vem NULL, e a tela imprime "--": R$ 0,00 de ticket seria mentira.
--
-- ------------------------------------------------------------
-- POR QUE SOMAR `orders_count`/`purchases_count` ENTRE (CONTA, DIA) E EXATO
-- ------------------------------------------------------------
-- METRICS.md 5.1 manda nunca somar contagem DISTINTA de grao inferior. A soma
-- aqui e exata pelos dois eixos:
--
--   entre CONTAS -- pack e pedido pertencem a UMA conta do Mercado Livre
--                   (D-017/D-050; e o mesmo argumento de `get_sales_summary`
--                   e `get_sales_daily_series`, que ja somam entre contas);
--   entre DIAS   -- um pack nao atravessa dias. MEDIDO no Dev em 03/09/2026,
--                   na fonte (`orders`, data civil de America/Sao_Paulo):
--                   172.624 packs, ZERO em mais de um dia.
--
-- Se um dia um pack atravessar a meia-noite, `purchases_count` do grao 'total'
-- e 'conta' passa a superestimar em 1 por pack -- o teste de integracao que
-- fecha "total = soma das contas = soma dos dias" continua passando (os tres
-- somam o mesmo), entao a guarda para ISSO e a medicao acima, refeita quando
-- houver motivo, nao o teste.
--
-- ------------------------------------------------------------
-- CONTRATOS
-- ------------------------------------------------------------
--   * A linha `total` EXISTE SEMPRE, mesmo para SKU sem venda na janela --
--     zeros nas somas, NULL nas razoes e em `last_computed_at`. Mesmo padrao
--     de `get_sku_dashboard` ("zeros, nao linha ausente"); ensaiado no Dev
--     antes de aplicar: 1 linha, 'total', 0, NULL, NULL.
--   * Dias sem venda NAO aparecem no grao 'dia' -- o recalculo nao fabrica
--     zero (mesmo contrato de `get_sales_daily_series` e de /vendas).
--   * `account_label` vem de LEFT JOIN: conta invisivel ou removida deixa a
--     venda visivel e o rotulo NULL. A venda aconteceu; esconder a linha
--     seria a mentira.
--   * `security invoker`: a RLS de `daily_sku_metrics`
--     (`has_account_access`) filtra ANTES do group by. `organization_id` e
--     parametro, como em `get_sku_dashboard`: quem passa a organizacao de
--     outro recebe a linha total ZERADA, nao um erro.
--
-- MEDIDO no Dev, SKU mais vendido da janela (74 linhas em 4 contas), quente:
-- 35 linhas devolvidas (1 + 4 + 30), 193 buffers, 1,4 ms. Entra por
-- `daily_sku_metrics_sku_date_idx`; nenhum indice novo.
-- ============================================================

create function public.get_sku_sales_breakdown(
  p_organization_id uuid,
  p_sku_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  grain text,
  metric_date date,
  ml_account_id uuid,
  account_label text,
  units_sold bigint,
  gross_revenue numeric,
  orders_count bigint,
  purchases_count bigint,
  average_ticket numeric,
  average_selling_price numeric,
  last_computed_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with linhas as (
    select
      m.metric_date,
      m.ml_account_id,
      a.label as account_label,
      m.units_sold,
      m.gross_revenue,
      m.orders_count,
      m.purchases_count,
      m.computed_at
    from public.daily_sku_metrics m
    left join public.ml_accounts a on a.id = m.ml_account_id
    where m.organization_id = p_organization_id
      and m.sku_id = p_sku_id
      and m.metric_date between p_date_from and p_date_to
  ),
  grupos as (
    select
      -- grouping() devolve um bit por coluna, o primeiro argumento no bit
      -- mais alto: 3 = as duas agregadas (total), 2 = so a data agregada
      -- (por conta), 1 = so a conta agregada (por dia).
      case grouping(l.metric_date, l.ml_account_id)
        when 3 then 'total'
        when 2 then 'conta'
        else 'dia'
      end as grain,
      l.metric_date,
      l.ml_account_id,
      l.account_label,
      coalesce(sum(l.units_sold), 0)::bigint as units_sold,
      coalesce(round(sum(l.gross_revenue), 2), 0) as gross_revenue,
      coalesce(sum(l.orders_count), 0)::bigint as orders_count,
      coalesce(sum(l.purchases_count), 0)::bigint as purchases_count,
      round(sum(l.gross_revenue) / nullif(sum(l.purchases_count), 0), 2) as average_ticket,
      round(sum(l.gross_revenue) / nullif(sum(l.units_sold), 0), 2) as average_selling_price,
      max(l.computed_at) as last_computed_at
    from linhas l
    group by grouping sets ((), (l.ml_account_id, l.account_label), (l.metric_date))
  )
  select
    g.grain, g.metric_date, g.ml_account_id, g.account_label,
    g.units_sold, g.gross_revenue, g.orders_count, g.purchases_count,
    g.average_ticket, g.average_selling_price, g.last_computed_at
  from grupos g
  -- total primeiro; contas por unidades vendidas; dias em ordem cronologica.
  order by
    case g.grain when 'total' then 0 when 'conta' then 1 else 2 end,
    g.metric_date,
    g.units_sold desc,
    g.account_label
$$;

comment on function public.get_sku_sales_breakdown(uuid, uuid, date, date) is
  'Vendas de um SKU na janela em TRES graos numa chamada (D-227, aba Vendas do Dashboard de SKU): grain = total | conta | dia, via grouping sets. Os seis canonicos de METRICS.md 5.2 no grao SKU; razoes sobre as SOMAS (nunca media de medias), NULL com denominador zero. A linha total existe sempre (zeros, nao ausente); dias sem venda nao aparecem. Soma entre contas e dias e exata: pack pertence a uma conta e nao atravessa dias (172.624 packs medidos, zero em mais de um dia). security invoker: a RLS de daily_sku_metrics filtra antes do group by.';

revoke all on function public.get_sku_sales_breakdown(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_sku_sales_breakdown(uuid, uuid, date, date) to authenticated, service_role;
