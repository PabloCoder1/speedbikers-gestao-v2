-- ============================================================
-- Tres RPCs sem chamador saem (auditoria de 2026-09-28).
--
-- Criterio, conferido em producao e no Dev antes de escrever:
--   - nenhum `.rpc("nome"` em apps/, packages/ e scripts/ (e nenhum `.rpc(`
--     com nome dinamico no codigo);
--   - nenhuma outra funcao SQL as chama (`pg_proc.prosrc`), nenhuma view,
--     trigger, policy ou default depende delas (`pg_depend`), e
--     `metric_definitions` nao as cita;
--   - zero chamadas no `pg_stat_statements` de producao de 18 a 28/09.
--
--   get_listing_sales       /anuncios passou a ler get_listings_dashboard
--   get_listing_traffic     idem (visitas e conversao vem do dashboard)
--   get_unlinked_listings   sem consumidor no codigo atual
--
-- FICAM, de proposito: `get_suppliers` e `get_purchase_state_counts` sao a
-- referencia dos testes de integracao que provam `get_suppliers_overview` e
-- `get_replenishment_overview`; `get_sales_margin_summary` e a implementacao
-- da metrica `margem_operacional_pedido` (docs/METRICS.md).
--
-- Os testes de integracao que exercitavam SO estas funcoes saem junto; os de
-- RLS da tabela `daily_listing_visits` ficam. `packages/db/src/types.ts` perde
-- as tres entradas.
-- ============================================================

drop function if exists public.get_listing_sales(uuid, date, date);
drop function if exists public.get_listing_traffic(uuid, date, date);
drop function if exists public.get_unlinked_listings(uuid, text, integer, integer);
