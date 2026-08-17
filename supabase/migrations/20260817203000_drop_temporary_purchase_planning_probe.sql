-- Remove o harness temporário criado em 20260817202000.
--
-- Ele existiu apenas para executar private.get_purchase_planning_signals
-- uma vez e validar, em produção, a compatibilidade entre RETURNS TABLE e
-- o SELECT final — que plpgsql só checa em execução. A verificação foi
-- feita: 2.892 SKUs físicos, 183 urgentes, 113 a comprar, 16.402 unidades
-- sugeridas, e o rateio de kits confirmado em 114 SKUs.
--
-- A exceção de service_role no helper (20260817202500) permanece, para que
-- essa verificação continue possível sem harness em mudanças futuras.

drop function if exists public.probe_purchase_planning(uuid);
