-- Etapa 1 de 3 na tentativa de baratear current_ml_sale_deductions.
--
-- Diagnostico por EXPLAIN da versao anterior: a view montava TODAS as
-- linhas vendidas da historia e so no fim aplicava
-- date_created > state.checked_at, no join externo. Processava 329 mil
-- linhas para devolver 84. Execution Time: 11.487 ms.
--
-- Cria indice orders_date_created_idx (o predicado nao tem ml_account_id,
-- entao nao podia usar orders_account_date_idx) e empurra um piso de data
-- para dentro de sold_lines usando min(checked_at) como limite inferior
-- comum, seguro porque todos os estados vem da mesma importacao.
--
-- Resultado medido: 11.487 ms -> 7.051 ms. Insuficiente.
-- Superseded por 20260818131932 e 20260818132023.

create index if not exists orders_date_created_idx
  on public.orders (date_created);

analyze public.orders;
