-- TENTATIVA REVERTIDA em 20260818131035. Mantida no historico porque foi
-- aplicada em producao.
--
-- Hipotese: materializar as duas views em CTEs proprios, escopados a
-- organizacao, faria o planner calcula-las uma vez.
--
-- Resultado medido: 15-22 s, praticamente sem ganho. O custo e a
-- varredura de orders/order_items, nao o numero de avaliacoes. Hipotese
-- descartada.
select 1;
