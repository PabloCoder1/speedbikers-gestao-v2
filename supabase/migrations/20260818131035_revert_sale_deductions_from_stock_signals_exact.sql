-- ============================================================
-- REVERSÃO: TIRAR AS BAIXAS DO CAMINHO QUENTE DE ESTOQUE
-- ============================================================
--
-- Aplicada em produção como 20260818131035.
--
-- As migrations 20260818130029 e 20260818130721 tentaram ligar
-- current_ml_sale_deductions e current_stock_manual_movements dentro de
-- private.get_stock_product_signals, para que o estoque exibido em
-- /estoque, /produtos e /compras já viesse com as vendas descontadas.
--
-- Resultado medido em produção:
--
--   antes           ~180-250 ms
--   com as views    15.000-22.000 ms
--   timeout         8.000 ms
--
-- Ou seja: /estoque e /produtos ficaram fora do ar. Revertido.
--
-- Causa raiz: current_ml_sale_deductions precisa varrer orders e
-- order_items (328 mil linhas cada) para todo SKU, e não existe índice
-- que atenda organization_id + date_created em orders. É a mesma lacuna
-- registrada na auditoria, quando uma consulta org-wide por data também
-- estourou o timeout. Materializar em CTE não ajudou porque o custo é a
-- varredura, não a repetição.
--
-- O que continua valendo: as views estão corretas e verificadas, e
-- current_ml_sale_deductions já contempla kits (20260818125211). O que
-- falta é um caminho barato para consumi-las.
--
-- Próximo passo, nesta ordem:
--   1. criar índice em orders (organization_id, date_created) e medir de
--      novo com EXPLAIN ANALYZE;
--   2. se ainda for caro, materializar a baixa numa tabela mantida pelo
--      próprio pipeline de pedidos, em vez de calculá-la a cada leitura;
--   3. só então religar no caminho quente, medindo ANTES de manter.

do $$
declare
  definition text;
  cte_block text;
  join_block text;
begin
  select pg_get_functiondef(p.oid)
  into definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'get_stock_product_signals';

  cte_block :=
    '  sale_deductions as materialized (' || E'\n' ||
    '    select deduction.sku_key, deduction.warehouse_key,' || E'\n' ||
    '           deduction.quantity, deduction.last_sale_at' || E'\n' ||
    '    from public.current_ml_sale_deductions as deduction' || E'\n' ||
    '    where deduction.organization_id = target_organization_id' || E'\n' ||
    '  ),' || E'\n' ||
    '  manual_movements as materialized (' || E'\n' ||
    '    select movement.sku_key, movement.warehouse_key,' || E'\n' ||
    '           movement.quantity, movement.last_movement_at' || E'\n' ||
    '    from public.current_stock_manual_movements as movement' || E'\n' ||
    '    where movement.organization_id = target_organization_id' || E'\n' ||
    '  ),' || E'\n' ||
    '  stock_by_warehouse as materialized (';

  definition := replace(definition, cte_block, '  stock_by_warehouse as materialized (');

  definition := replace(
    definition,
    '      state.available_quantity + coalesce(adjustment.quantity, 0)' || E'\n' ||
    '        - coalesce(sale.quantity, 0) + coalesce(manual.quantity, 0) as available_quantity,' || E'\n' ||
    '      state.current_quantity + coalesce(adjustment.quantity, 0)' || E'\n' ||
    '        - coalesce(sale.quantity, 0) + coalesce(manual.quantity, 0) as current_quantity,',
    '      state.available_quantity + coalesce(adjustment.quantity, 0) as available_quantity,' || E'\n' ||
    '      state.current_quantity + coalesce(adjustment.quantity, 0) as current_quantity,'
  );

  definition := replace(
    definition,
    '      greatest(state.checked_at, adjustment.applied_at, sale.last_sale_at, manual.last_movement_at) as updated_at',
    '      greatest(state.checked_at, adjustment.applied_at) as updated_at'
  );

  join_block :=
    '    left join sale_deductions as sale' || E'\n' ||
    '      on sale.sku_key = state.sku_key' || E'\n' ||
    '     and sale.warehouse_key = state.warehouse_key' || E'\n' ||
    '    left join manual_movements as manual' || E'\n' ||
    '      on manual.sku_key = state.sku_key' || E'\n' ||
    '     and manual.warehouse_key = state.warehouse_key' || E'\n';

  definition := replace(definition, join_block, '');

  if position('sale.quantity' in definition) > 0
     or position('manual.quantity' in definition) > 0
     or position('sale_deductions' in definition) > 0
     or position('manual_movements' in definition) > 0 then
    raise exception 'revert_incomplete';
  end if;

  execute definition;
end $$;
