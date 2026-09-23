-- ============================================================
-- D-394 - Central do negocio: a variacao entre periodos entra no catalogo
--
-- docs/METRICS.md 5.4 deixava `variacao_percentual_periodo` pendente, e por
-- D-023 nenhuma tela podia mostrar "+12,8%" sem definicao por tras. A Central
-- do negocio (/central) passa a mostrar a variacao de cada indicador contra o
-- periodo anterior, com tom pela polaridade (METRICS 5I). As duas definicoes
-- abaixo espelham 5I; o tom e as janelas de comparacao sao regra da tela,
-- documentada la.
--
-- So catalogo: nenhuma tabela, funcao ou dado de negocio muda. A tela nao le
-- estas linhas em tempo de execucao (mostra o id), entao funciona antes e
-- depois desta migration chegar a producao.
-- ============================================================

insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions,
   cancellation_treatment, timezone, definition_updated_on)
values
  (
    'variacao_percentual_periodo',
    'Variação percentual contra o período anterior',
    '(atual - anterior) / anterior; NULL quando anterior <= 0 ou ausente',
    'Duas leituras da mesma métrica canônica, no período atual e no anterior (docs/METRICS.md 5I)',
    array['account', 'organization'],
    'Métricas em reais, contagens e razões que não são fração (receita, pedidos, ticket, resultado, frete médio, investimento e vendas com Ads, ROAS).',
    'Métricas que são fração (margem, participações, ACOS, TACoS) usam variacao_pontos_percentuais. Sem um dos lados não há variação, nunca 0%.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-09-23'
  ),
  (
    'variacao_pontos_percentuais',
    'Variação em pontos percentuais contra o período anterior',
    'fracao_atual - fracao_anterior; NULL quando um dos lados é NULL',
    'Duas leituras da mesma métrica em fração, no período atual e no anterior (docs/METRICS.md 5I)',
    array['account', 'organization'],
    'margem_venda, comissao_percentual, participação do custo na receita coberta, acos e tacos.',
    'Métricas em reais e contagens usam variacao_percentual_periodo. Sem um dos lados não há variação, nunca 0 p.p.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-09-23'
  );
