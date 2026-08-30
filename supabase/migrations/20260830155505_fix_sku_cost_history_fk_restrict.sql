-- Correcao de D-149, cobrada pela CI #270 no TEARDOWN da suite (todos os
-- 404 testes passaram; o afterAll caiu): FK em CASCADE + gatilho
-- append-only e CONTRADICAO -- o cascade dispara exatamente o DELETE que o
-- gatilho rejeita, entao o SKU ficava indeletavel do jeito mais tortuoso, e
-- um unico SKU com historico derrubava o DELETE em lote inteiro (a classe
-- de D-099: uma falha escondendo o conjunto).
--
-- O padrao correto ja existia na casa: tabela de AUDITORIA prende o SKU por
-- RESTRICT (sku_listing_link_events faz isso desde D-125) e o teardown dos
-- testes ganha a guarda NOT EXISTS correspondente. Historia e historia --
-- a racionalizacao "custo de quem nunca operou nao e historia perdida" de
-- D-149 morreu contra o proprio gatilho que a fatia criou.

alter table public.sku_cost_history
  drop constraint sku_cost_history_sku_id_fkey;

alter table public.sku_cost_history
  add constraint sku_cost_history_sku_id_fkey
    foreign key (sku_id) references public.skus(id) on delete restrict;

comment on table public.sku_cost_history is
  'Historico append-only do custo cadastrado (skus.purchase_cost), gravado por trigger a cada mudanca (D-149). previous_cost nulo = primeiro registro (SKU nasceu com custo); new_cost nulo = custo apagado. changed_by_role: service_role = importacao/worker, postgres = operacao direta. SEM backfill: o registro comeca em 2026-08-30 e a tela declara isso. FK do SKU em RESTRICT (corrigido pela CI #270): cascade + append-only era contradicao -- o cascade dispara o DELETE que o proprio gatilho rejeita. Custo de SIMULACAO/pedido vive em purchase_order_items.unit_cost e NUNCA escreve de volta em skus.';
