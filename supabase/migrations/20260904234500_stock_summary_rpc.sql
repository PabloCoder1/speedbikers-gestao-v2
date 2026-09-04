-- ============================================================
-- `get_stock_summary` -- a faixa de KPIs de `/estoque` (D-249, fatia D14).
--
-- O frame `Inventory` do Figma desenha SEIS celulas: Unidades local,
-- Reservado, Em transito, Full, Valor estimado, Em ruptura. A conferencia
-- celula a celula contra o que o sistema MEDE -- o procedimento que D13 provou
-- valer -- mostrou que **tres delas nao tem resposta honesta hoje**, e as
-- outras tres tem.
--
-- ------------------------------------------------------------
-- 1. UNIDADES LOCAL E VALOR ESTIMADO: sentinela, nao contagem
-- ------------------------------------------------------------
-- Somando `inventory_balances` LOCAL cru, o Dev responde **5.861.031
-- unidades** e **R$ 376.106.618** de valor. O frame desenha 18.426 e R$ 2,18
-- milhoes. A diferenca nao e de escala de fixture -- e de SIGNIFICADO:
--
--   mediana de saldo por SKU     997 unidades
--   p95                        9.996 unidades
--   maior saldo               28.700 unidades
--   top 10 SKUs                  2,4% do total  <- NAO sao outliers
--
-- A distribuicao INTEIRA tem forma de sentinela, que e exatamente o que D-127
-- mediu: o saldo do ERP e um sentinela, nao uma contagem fisica ("a hipotese
-- 'base menos vendas' foi testada e reprovada, correlacao 0,291").
--
-- **E a classificacao nunca foi feita:** `stock_is_virtual_set_at` e NULO em
-- **3.554 de 3.554** SKUs. Ou seja, `stock_is_virtual = false` no banco e o
-- DEFAULT da coluna, nao o julgamento de ninguem. Somar isso e apresentar como
-- "posicao de estoque" seria a tela afirmando com confianca um numero falso --
-- e multiplicado por custo, seria afirmando dinheiro.
--
-- **Por isso as duas somas contam SO o que um humano confirmou como fisico**
-- (`stock_is_virtual_set_at is not null and not stock_is_virtual`). Hoje isso
-- da zero, e a tela diz que da zero POR FALTA DE CLASSIFICACAO, com link para
-- `/produtos`. Conforme o ato humano avanca, os numeros aparecem sozinhos --
-- a regra nao precisa ser reescrita.
--
-- ------------------------------------------------------------
-- 2. EM TRANSITO: a coluna existe, o dado nunca existiu
-- ------------------------------------------------------------
-- `stock_movements` tem **ZERO** linhas com `location_kind = 'TRANSITO'`, e os
-- unicos tipos ja movimentados sao LOCAL e RESERVADO. Nao e "esta zerado
-- hoje": e um tipo de local que nenhum caminho de escrita alimenta.
--
-- A funcao devolve a contagem MESMO ASSIM (`transito`), e devolve junto
-- `transito_tem_registro` -- para a tela poder dizer "nao ha registro de
-- transito" em vez de "0", que sao afirmacoes diferentes. Zero e ausencia nao
-- se confundem (D-067).
--
-- ------------------------------------------------------------
-- 3. RESERVADO E FULL: os dois numeros honestos da faixa
-- ------------------------------------------------------------
-- `RESERVADO` vem de pedido real (300 SKUs, mediana 1) e o Full vem do
-- snapshot do Mercado Livre. O Full usa a **definicao canonica** -- ultima
-- captura por bucket `inventory_id` dentro de 3 dias (D-173/D-192) --, nunca
-- uma soma propria: dois lugares somando Full de jeitos diferentes foi
-- exatamente o defeito que D13 achou entre a lista e o detalhe do anuncio.
--
-- ------------------------------------------------------------
-- 4. OS MESMOS FILTROS DA TABELA, E ISSO NAO E DETALHE
-- ------------------------------------------------------------
-- A faixa recebe os MESMOS parametros de `get_stock_balances`. Uma faixa que
-- ignora o filtro da tabela logo abaixo dela faz cabecalho e corpo falarem de
-- conjuntos diferentes na mesma tela -- o defeito que D-236 mediu em
-- `/cobertura` e consertou repassando o recorte aos totais.
--
-- "Em ruptura" NAO entra aqui: ela ja tem dono canonico em
-- `get_stock_coverage_summary` (D-131), com janela de periodo. Recriar a
-- contagem aqui seria a segunda definicao da mesma palavra.
-- ============================================================

create function public.get_stock_summary(
  p_organization_id uuid,
  p_supplier_brand text default null,
  p_category text default null,
  p_search text default null,
  p_only_negative boolean default false
)
returns table (
  skus_no_recorte bigint,
  skus_confirmados_fisicos bigint,
  skus_nao_classificados bigint,
  unidades_local numeric,
  valor_estimado numeric,
  reservado numeric,
  transito numeric,
  transito_tem_registro boolean,
  full_quantity numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with escopo as (
    -- Mesmo recorte de `get_stock_balances`, para faixa e tabela nunca
    -- falarem de conjuntos diferentes.
    select sk.id, sk.purchase_cost, sk.stock_is_virtual, sk.stock_is_virtual_set_at
    from public.skus sk
    where sk.organization_id = p_organization_id
      and (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand)
      and (p_category is null or coalesce(sk.category_raw, sk.brand) = p_category)
      and (p_search is null
           or sk.sku ilike '%' || p_search || '%'
           or sk.title ilike '%' || p_search || '%')
  ),
  saldos as (
    select b.sku_id, b.location_kind, b.quantity
    from public.inventory_balances b
    join escopo e on e.id = b.sku_id
    where b.organization_id = p_organization_id
  ),
  local_confirmado as (
    -- SO o que foi CLASSIFICADO como fisico por gente. Ver secao 1: hoje sao
    -- zero SKUs, e a tela diz isso em vez de somar sentinela.
    select coalesce(sum(s.quantity), 0) as unidades,
           coalesce(sum(s.quantity * e.purchase_cost), 0) as valor
    from saldos s
    join escopo e on e.id = s.sku_id
    where s.location_kind = 'LOCAL'
      and e.stock_is_virtual_set_at is not null
      and not e.stock_is_virtual
  ),
  full_atual as (
    -- Definicao canonica: ultima captura por bucket, janela de 3 dias.
    select coalesce(sum(x.quantity), 0) as quantidade
    from (
      select distinct on (f.ml_account_id, f.inventory_id) f.quantity
      from public.fulfillment_stock_snapshots f
      join escopo e on e.id = f.sku_id
      where f.organization_id = p_organization_id
        and f.captured_at >= now() - interval '3 days'
      order by f.ml_account_id, f.inventory_id, f.captured_at desc
    ) x
  )
  select
    (select count(*) from escopo)::bigint,
    (select count(*) from escopo where stock_is_virtual_set_at is not null and not stock_is_virtual)::bigint,
    (select count(*) from escopo where stock_is_virtual_set_at is null)::bigint,
    lc.unidades,
    round(lc.valor, 2),
    (select coalesce(sum(quantity), 0) from saldos where location_kind = 'RESERVADO'),
    (select coalesce(sum(quantity), 0) from saldos where location_kind = 'TRANSITO'),
    -- Ausencia estrutural, nao saldo zero: distingue "nada em transito hoje"
    -- de "nenhum caminho escreve transito".
    (select exists (select 1 from public.stock_movements m
                    where m.organization_id = p_organization_id and m.location_kind = 'TRANSITO')),
    fa.quantidade
  from local_confirmado lc, full_atual fa
$$;

comment on function public.get_stock_summary(uuid, text, text, text, boolean) is
  'Faixa de KPIs de /estoque (D-249). Recebe os MESMOS filtros de get_stock_balances -- faixa e tabela nunca falam de conjuntos diferentes (licao de D-236). `unidades_local` e `valor_estimado` somam SO os SKUs que um humano confirmou como fisicos (stock_is_virtual_set_at is not null): o saldo do ERP e sentinela (D-127) e a classificacao nunca foi feita (3.554 de 3.554 sem set_at), entao somar o default seria afirmar contagem -- e dinheiro -- que ninguem mediu. `transito_tem_registro` distingue ausencia estrutural de saldo zero: nao ha NENHUM stock_movement de TRANSITO. Full pela definicao canonica (ultima captura por bucket em 3 dias). Ruptura NAO entra: dono canonico e get_stock_coverage_summary. security invoker.';

revoke all on function public.get_stock_summary(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.get_stock_summary(uuid, text, text, text, boolean) to authenticated, service_role;
