-- ============================================================
-- D-356 -- O PRODUTO DOS PEDIDOS ANTIGOS: `order_items.sku_id` preenchido
-- pelos vinculos que ja existem.
--
-- MEDIDO em producao, 15/09/2026:
--
--   | o que                                           | quanto                 |
--   |-------------------------------------------------|------------------------|
--   | itens de pedido (desde 14/09/2025)              | 329.240                |
--   | sem `sku_id`                                    | 326.029 (99%)          |
--   | com vinculo EXATO ja cadastrado                 | 248.453                |
--   | receita com produto, ultimos 30 dias            | 10,5% -> ~76%          |
--
-- A causa: o worker resolve o vinculo AO GRAVAR o pedido (D-020), e o
-- historico de producao entrou antes de os 16.962 vinculos do UpSeller
-- serem importados. Nenhum fluxo preenche `sku_id` depois (medido: nenhum
-- codigo SQL ou TS escreve em `order_items.sku_id` fora da persistencia).
-- Sem produto nao ha custo, e sem custo a margem de D-356 cobriria um
-- decimo das vendas; o ranking de /vendas ja mostra so esse decimo.
--
-- ------------------------------------------------------------
-- A REGRA E A DO WORKER, EXATA -- senao o proximo reprocessamento desfaz
--
-- `persist-order.ts` casa vinculo ITEM, mesma conta, mesmo `item_id` e a
-- MESMA variacao: venda com variacao nao cai no vinculo do anuncio sem
-- variacao, e vinculo USER_PRODUCT nao e usado. Qualquer regra mais larga
-- aqui seria sobrescrita no primeiro reprocessamento do pedido, e o numero
-- mudaria sozinho. Os indices unicos parciais de `sku_listing_links` garantem
-- no maximo um vinculo por chave.
--
-- ------------------------------------------------------------
-- O QUE NAO ACONTECE, e foi conferido antes
--
-- - Nenhum movimento de estoque: a unica trigger de `order_items` e a de
--   `updated_at`; a baixa por venda nasce no worker e so para quem ele
--   persiste. A sessao da D-351 mediu que o script de compensacao dela
--   continua pegando os mesmos pedidos.
-- - Nenhum valor ja preenchido muda: so `sku_id IS NULL`.
-- - Nenhum vinculo e criado.
--
-- ------------------------------------------------------------
-- O RECALCULO
--
-- `daily_sku_metrics` agrupa por `order_items.sku_id`: sem recalcular, o
-- ranking de /vendas e as curvas por SKU continuariam no balde "sem produto".
-- `private.refresh_daily_sales_metrics` roda por conta, do primeiro ao ultimo
-- dia tocado, e so regrava a linha cujo numero mudou (D-199). Medido: calcular
-- um ano da maior conta leva 2,4 s.
--
-- Efeito esperado, dito antes: a deteccao de venda anomala e as sugestoes de
-- compra passam a enxergar vendas por SKU que antes estavam no balde nulo --
-- pode sair uma leva de notificacoes no dia seguinte.
-- ============================================================

-- A leitura casa ~250 mil itens e o recalculo percorre um ano por conta:
-- sem teto de tempo por comando, a aplicacao nao morre no meio.
set local statement_timeout = 0;

do $$
declare
  v_itens bigint;
  v_linhas integer;
  v_conta record;
begin
  create temporary table _d356_preenchidos (
    organization_id uuid not null,
    ml_account_id uuid not null,
    dia date not null
  ) on commit drop;

  with alvo as (
    select oi.id as order_item_id, l.id as link_id, l.sku_id
    from public.order_items oi
    join public.sku_listing_links l
      on l.ml_account_id = oi.ml_account_id
     and l.organization_id = oi.organization_id
     and l.ref_kind = 'ITEM'
     and l.item_id = oi.item_id
     and l.variation_id is not distinct from oi.variation_id
    where oi.sku_id is null
      and l.sku_id is not null
  ),
  atualizados as (
    update public.order_items oi
    set sku_id = a.sku_id,
        sku_listing_link_id = a.link_id
    from alvo a
    where oi.id = a.order_item_id
      and oi.sku_id is null
    returning oi.organization_id, oi.ml_account_id, oi.order_id
  )
  insert into _d356_preenchidos (organization_id, ml_account_id, dia)
  select u.organization_id, u.ml_account_id, (o.date_created at time zone 'America/Sao_Paulo')::date
  from atualizados u
  join public.orders o on o.id = u.order_id;

  get diagnostics v_itens = row_count;
  raise notice 'D-356: % itens de pedido ganharam sku_id', v_itens;

  for v_conta in
    select organization_id, ml_account_id, min(dia) as de, max(dia) as ate, count(*) as itens
    from _d356_preenchidos
    group by organization_id, ml_account_id
  loop
    v_linhas := private.refresh_daily_sales_metrics(
      v_conta.organization_id, v_conta.ml_account_id, v_conta.de, v_conta.ate
    );

    raise notice 'D-356: conta % (% itens, % a %): % linhas de metrica regravadas',
      v_conta.ml_account_id, v_conta.itens, v_conta.de, v_conta.ate, v_linhas;
  end loop;
end;
$$;
