-- O comentário da tabela afirmava "mesmo escopo de listings/Full: só itens
-- sem variação (sku_listing_links.ref_kind=ITEM, variation_id is null)".
-- Falso desde D-124: a varredura passou a enumerar `listings` com status
-- ativo, então anúncio COM variação e anúncio SEM vínculo entram.
--
-- `daily_listing_visits` nunca exigiu SKU (grão é conta+item), o que é
-- justamente o que torna isso possível — diferente de
-- `fulfillment_stock_snapshots`, cujo `sku_id` é NOT NULL e por isso segue
-- preso à enumeração por vínculo.

comment on table public.daily_listing_visits is
  'Espelho diario de visitas por anuncio, direto da API de Visitas do Mercado Livre (GET /items/{item_id}/visits/time_window) — nao e recomputado do nosso lado. Grao (ml_account_id, item_id, metric_date). Escopo desde D-124: anuncios do CATALOGO com status ativo (inclui itens com variacao e itens sem vinculo); a API aceita 1 item por chamada, entao pausado/encerrado fica de fora de proposito.';
