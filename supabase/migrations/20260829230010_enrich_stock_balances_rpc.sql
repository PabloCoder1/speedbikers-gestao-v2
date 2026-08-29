-- Estoque enriquecido (D-139): `/estoque` mostrava quatro colunas -- SKU,
-- Local, Reservado, Trânsito -- enquanto marca, categoria, custo, Full e datas
-- já existiam no banco e nenhuma tela as lia. É o item da Fase 5C, e o
-- `docs/PRODUCT_REQUIREMENTS.md` já dizia isso com todas as letras.
--
-- MEDIDO ANTES DE ESCOLHER AS COLUNAS, porque coluna quase vazia é ruído e
-- coluna errada é pior que coluna ausente:
--
--   `category_raw`   95,7% preenchido  -> entra
--   `purchase_cost`  94,9%             -> entra
--   `brand`          82,9%             -> entra como CATEGORIA (D-129: `brand`
--                                         NAO é marca, é a categoria do
--                                         UpSeller), só como fallback de
--                                         `category_raw`
--   `supplier_brand` 36,0%             -> entra: é a marca REAL (D-129), e o
--                                         vazio é deliberado, esperando
--                                         preenchimento humano em `/produtos`
--   `origin_code`    94,3%             -> VETADO (D-129)
--   `is_imported`    94%               -> VETADO AGORA, pelo mesmo motivo
--
-- O veto de `is_imported` é achado desta migration, e confirma D-129 numa
-- SEGUNDA coluna: ele diz que 187 dos 228 SKUs NAVETEC são nacionais, contra a
-- regra de negócio que o usuário estabeleceu (Navetec é importado). Assim como
-- `origin_code`, `is_imported` carrega a origem FISCAL preenchida por quem
-- emite a nota, não a rota de compra. O `docs/PRODUCT_REQUIREMENTS.md` já
-- avisava: "nem hardcode por marca, nem confiança cega em `is_imported`".
-- Por isso NAO existe coluna Origem nesta tela -- mostrar "Nacional" para
-- Navetec seria a tela afirmando com confiança algo falso.
--
-- VALOR DE ESTOQUE CONTINUA FORA, e a razão mudou de lugar. O
-- `docs/METRICS.md` 5C.4 o bloqueava "até a questão do estoque sentinela ser
-- resolvida". A QUESTAO foi resolvida (D-127: é estoque virtual deliberado) e
-- a ferramenta existe (D-133), mas medido hoje: 1.089 SKUs carregam a
-- assinatura sentinela e ZERO estão classificados. Somar quantidade x custo
-- hoje produziria um número inflado com aparência de precisão -- exatamente o
-- que a Regra de Progressão proíbe. O bloqueio saiu de "pergunta aberta" e
-- virou "classificação não feita": quem destrava é o ensaio de `/produtos`.
--
-- MEDIÇÕES DE PERFORMANCE (docs/ARCHITECTURE.md secao 21), e as duas primeiras
-- versões foram reprovadas:
--
--   1a versão: 1.646 ms, 132.368 buffers.
--   * `distinct on` sobre `fulfillment_stock_snapshots` varria as 60.086
--     linhas históricas para achar a mais recente. Medido que `captured_at` é
--     carimbo POR RODADA (130 carimbos, ~462 linhas cada), não por item --
--     então basta juntar com o `max(captured_at)` de cada conta e ler ~1.848
--     linhas. -> 1.024 ms, 79.436 buffers.
--   * o resto do custo era `max(occurred_at)` sobre `stock_movements`: 70.732
--     buffers e 224 mil linhas varridas, com `Heap Fetches: 69872` num
--     index-only scan. A causa não era a consulta: o reparo em massa de D-134
--     inseriu 6.672 movimentos e deixou o mapa de visibilidade defasado.
--     `vacuum (analyze)` -> 11.052 buffers, 132 ms quente.
--
-- LIÇAO OPERACIONAL REGISTRADA: reparo em massa no ledger deve ser seguido de
-- `VACUUM ANALYZE`. Sem isso, toda consulta que agrega `stock_movements` paga
-- 6x em buffers, silenciosamente.
--
-- "Último movimento" usa `stock_movements.occurred_at`, NAO
-- `inventory_balances.updated_at`. Testei a substituição barata: 3.148 dos
-- 3.174 SKUs concordam no dia, mas o desvio máximo é de 278 dias -- porque
-- movimento retroativo (backfill de pedido antigo) tem `occurred_at` velho e
-- `updated_at` recente. São coisas diferentes, e numa tela de estoque o
-- operador quer a data do FATO, não a de quando gravamos.
--
-- Substitui a assinatura de D-131 em vez de criar função nova: `/estoque` era
-- o único chamador, e deixar a antiga viva seria código morto.

drop function public.get_stock_balances(uuid);

create function public.get_stock_balances(
  p_organization_id uuid,
  p_supplier_brand text default null,
  p_category text default null,
  p_search text default null,
  p_only_negative boolean default false,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  sku_id uuid, sku text, title text, local_quantity numeric, reservado numeric,
  transito numeric, full_quantity numeric, supplier_brand text, category text,
  purchase_cost numeric, created_at timestamptz, last_movement_at timestamptz,
  stock_is_virtual boolean, stock_is_virtual_set_at timestamptz, total_count bigint
)
language sql stable security invoker set search_path = ''
as $$
  with pivot as (
    select b.sku_id,
      sum(b.quantity) filter (where b.location_kind = 'LOCAL')     as local_quantity,
      sum(b.quantity) filter (where b.location_kind = 'RESERVADO') as reservado,
      sum(b.quantity) filter (where b.location_kind = 'TRANSITO')  as transito
    from public.inventory_balances b
    where b.organization_id = p_organization_id
    group by b.sku_id
  ),
  ultima_captura as (
    -- `captured_at` é carimbo por RODADA do job, não por item: ler só a última
    -- de cada conta troca 60.086 linhas por ~1.848.
    select f.ml_account_id, max(f.captured_at) as captured_at
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
    group by f.ml_account_id
  ),
  full_por_sku as (
    select f.sku_id, sum(f.quantity) as full_quantity
    from public.fulfillment_stock_snapshots f
    join ultima_captura u
      on u.ml_account_id = f.ml_account_id and u.captured_at = f.captured_at
    where f.organization_id = p_organization_id
    group by f.sku_id
  ),
  ultimo_movimento as (
    select m.sku_id, max(m.occurred_at) as last_movement_at
    from public.stock_movements m
    where m.organization_id = p_organization_id
    group by m.sku_id
  ),
  base as (
    select p.sku_id, sk.sku, sk.title,
      coalesce(p.local_quantity, 0) as local_quantity,
      coalesce(p.reservado, 0) as reservado,
      coalesce(p.transito, 0) as transito,
      fp.full_quantity, sk.supplier_brand,
      -- `category_raw` primeiro (95,7% preenchido), `brand` como fallback --
      -- e `brand` E categoria, não marca (D-129).
      coalesce(sk.category_raw, sk.brand) as category,
      sk.purchase_cost, sk.created_at, um.last_movement_at,
      sk.stock_is_virtual, sk.stock_is_virtual_set_at
    from pivot p
    join public.skus sk on sk.id = p.sku_id
    left join full_por_sku     fp on fp.sku_id = p.sku_id
    left join ultimo_movimento um on um.sku_id = p.sku_id
    where (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand)
      and (p_category is null or coalesce(sk.category_raw, sk.brand) = p_category)
      and (p_search is null
           or sk.sku   ilike '%' || p_search || '%'
           or sk.title ilike '%' || p_search || '%')
      and (not p_only_negative or coalesce(p.local_quantity, 0) < 0)
  )
  select b.*, count(*) over () as total_count
  from base b order by b.sku
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

comment on function public.get_stock_balances(uuid, text, text, text, boolean, integer, integer) is
  'Estoque enriquecido (D-139): saldo pivotado LOCAL/RESERVADO/TRANSITO mais Full (ultimo snapshot por conta, somado), marca real do fornecedor, categoria, custo, data de criacao e ultimo movimento, com filtros e janela. NAO devolve valor de estoque: 1.089 SKUs carregam a assinatura sentinela e ZERO estao classificados (docs/METRICS.md 5C.4). Nao expoe origem nacional/importado: is_imported e origin_code sao fiscais e contradizem a rota de compra (D-129).';

revoke all on function public.get_stock_balances(uuid, text, text, text, boolean, integer, integer) from public, anon;
grant execute on function public.get_stock_balances(uuid, text, text, text, boolean, integer, integer) to authenticated, service_role;
