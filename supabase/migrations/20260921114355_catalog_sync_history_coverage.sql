-- ============================================================
-- Catálogo da cobertura do histórico de pedidos em /sincronizacao.
--
-- O indicador já nasce com o limite que impede um 100% enganoso: enquanto o
-- cursor não alcançar connected_at, a apresentação fica no máximo em 99%.
-- Não altera schema nem dados de negócio; apenas espelha METRICS.md 5H na
-- tabela canônica, como exige D-023.
-- ============================================================

insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions,
   cancellation_treatment, timezone, definition_updated_on)
values
  (
    'cobertura_historico_pedidos',
    'Cobertura do histórico de pedidos',
    'clamp((backfill_covered_until - (agora - 365 dias)) / (connected_at - (agora - 365 dias)), 0%, 99%); 100% somente quando backfill_covered_until >= connected_at',
    'ml_accounts.backfill_covered_until e ml_accounts.connected_at; retenção de 365 dias do handler backfill.orders',
    array['account'],
    'Janela histórica de pedidos ainda recuperável no Mercado Livre, por conta.',
    'Anúncios, visitas, Full, Ads, saúde atual dos jobs e conta sem connected_at.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-09-21'
  );
