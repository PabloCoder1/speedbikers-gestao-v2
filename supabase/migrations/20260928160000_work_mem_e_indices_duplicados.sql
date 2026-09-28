-- ============================================================
-- Auditoria de 2026-09-28: `work_mem` nas tres funcoes que despejavam em disco
-- e os quatro indices que repetem exatamente uma constraint unique.
--
-- 1. WORK_MEM POR FUNCAO. O `work_mem` da instancia e 3,5 MB. Em producao, de
-- 18 a 28/09, `get_faturamento`, `get_detector_frete` e
-- `sincronizar_alertas_central` gravaram ~7,7 GB em arquivos temporarios
-- (1.707 arquivos); `sync-central-alerts` falhou 3 de 8 vezes por
-- `statement_timeout` na fonte `produto_prejuizo`. Medido no Dev (dados ate
-- 14/09; `authenticated` nas duas primeiras, `postgres` em rollback na
-- terceira, que grava):
--
--                                  3,5 MB              16 MB            32 MB
--   get_detector_frete       148-380 ms, 589 blk    141 ms, 0 blk    141 ms, 0
--   get_faturamento (90 d)   1,38-2,68 s, 7.937     1,36-1,50 s, 1.499  1,37-1,46 s, 743
--   sincronizar (prejuizo)   885 ms, 4.281 blk      687 ms, 0 blk
--
-- `set work_mem` NA FUNCAO vale so durante a execucao dela: nao muda a
-- instancia, e as outras ~60 conexoes continuam com 3,5 MB.
--
-- 2. INDICES DUPLICADOS. Cada um tem as MESMAS colunas, na mesma ordem, de uma
-- constraint unique (ou e prefixo dela), e a unique tambem cobre a FK. Hoje o
-- planejador escolhe o nao-unico, entao a unique parece "sem uso" -- nao e.
-- Sao pequenos (8 a 16 kB): o ganho e escrita e manutencao, nao espaco.
--
-- FICA DE FORA, de proposito: `fulfillment_stock_snapshots_timeline_idx`
-- `(ml_account_id, inventory_id, captured_at DESC)`. A unique e toda ASC, e a
-- varredura reversa dela da DESC,DESC,DESC -- nao a ordem mista do
-- `distinct on` do Full. Sem ele, o ensaio no Dev trocou para unique + sort
-- incremental; o numero nao foi conclusivo (cache aquecendo entre as
-- medidas), e e o indice mais lido da tabela. PRECISA INVESTIGAR com as RPCs
-- reais antes de sair.
-- ============================================================

alter function public.get_detector_frete(uuid, date) set work_mem = '16MB';
alter function public.sincronizar_alertas_central(uuid, date, text[]) set work_mem = '16MB';
alter function public.get_faturamento(date, date, uuid, boolean) set work_mem = '32MB';

-- = document_items_unique_per_document (document_id, position)
drop index if exists public.document_items_document_idx;
-- = purchase_order_items_unique_position (purchase_order_id, position)
drop index if exists public.purchase_order_items_order_idx;
-- = reply_templates_organization_id_name_key (organization_id, name)
drop index if exists public.reply_templates_org_idx;
-- prefixo de saved_filters_created_by_screen_name_key (created_by, screen, name)
drop index if exists public.saved_filters_screen_idx;
