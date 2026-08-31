-- ============================================================
-- Catalogo de metricas: `visitas` e `taxa_conversao` (D-170).
--
-- As duas ja estavam NA TELA desde a Fase 5B, mas fora do catalogo —
-- numero exibido sem definicao canonica e exatamente o que D-023 proibe.
-- docs/METRICS.md ainda as listava como "fonte nao confirmada", texto que
-- envelheceu: `daily_listing_visits` existe desde D-032 e a coleta foi
-- corrigida em D-156.
--
-- A definicao de conversao declara a base que a medicao no Dev exigiu:
-- pedidos dos DIAS EM QUE HOUVE COLETA de visitas, nunca da janela inteira
-- (o mesmo principio do subconjunto coberto de D-166).
-- ============================================================

insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('visitas',
   'Visitas do anuncio',
   'SUM(daily_listing_visits.visits)',
   'API do Mercado Livre /visits/items por dia (D-032), persistida em daily_listing_visits pelo job sync.listing-visits.snapshot; a coleta ganhou checkpoint por linha e espacamento em D-156.',
   array['listing','account','organization'],
   'Todas as visitas que o Mercado Livre reporta para o anuncio no dia, por conta. Visita e do ANUNCIO: um item com variacoes tem uma unica contagem, nao uma por variacao.',
   'Nao existe grao de SKU: a fonte e por MLB, e somar visitas de anuncios distintos para um SKU exigiria vinculo completo. Dia sem coleta e AUSENCIA de observacao, nunca zero visita.',
   'included',
   'America/Sao_Paulo',
   '2026-08-31'),
  ('taxa_conversao',
   'Taxa de conversao do anuncio',
   'SUM(pedidos nos dias com visita observada) / NULLIF(SUM(visitas), 0)',
   'daily_listing_metrics.orders_count (nosso ledger de vendas) sobre daily_listing_visits.visits (Mercado Livre) — DUAS fontes distintas, com coberturas temporais distintas, na mesma razao.',
   array['listing','account','organization'],
   'Fracao (0,0728 = 7,28%), mesmo padrao de taxa_cancelamento; a tela formata em percentual e declara em quantos dias houve observacao.',
   'Pedidos de dias SEM coleta de visitas ficam fora do numerador: medido no Dev em 2026-08-31, incluir a janela inteira sobre um denominador de 11 dias de coleta produzia 93 anuncios acima de 100%, ate 2900%. Periodo sem NENHUMA visita devolve NULL, nunca Infinity nem 0% fingido. Nao e conversao de sessao nem funil do ML: e pedido nosso sobre visita deles.',
   'excluded',
   'America/Sao_Paulo',
   '2026-08-31');
