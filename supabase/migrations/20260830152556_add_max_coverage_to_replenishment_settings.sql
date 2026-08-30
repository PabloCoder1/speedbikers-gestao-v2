-- Estados operacionais calculados (D-148, Fase 5D): o "buffer maximo" que o
-- PRD nomeia na secao "Configuracoes de reposicao" e que D-144 nao
-- implementou -- ele so ganha significado agora, como o teto do estado
-- EXCESSO.
--
-- NULO E ESTADO LEGITIMO, nao falta de dado: sem teto configurado, o estado
-- EXCESSO nunca e afirmado (quanto e "demais" e decisao do ADMIN, nao
-- constante do codigo) -- mesmo desenho da recusa de D-144. Por isso a
-- coluna nasce anulavel e NENHUMA linha existente e preenchida.
--
-- A COERENCIA e contrato do banco: teto abaixo da propria janela de demanda
-- (prazo + cobertura + seguranca) tornaria o estado ADEQUADA impossivel --
-- toda cobertura na janela ja estaria "em excesso". O CHECK recusa a
-- configuracao contraditoria na origem, com as colunas da mesma linha.
--
-- Faixa 1..1095: a janela maxima possivel e 3 x 365.

alter table public.replenishment_settings
  add column max_coverage_days integer
    check (max_coverage_days is null or (max_coverage_days between 1 and 1095));

alter table public.replenishment_settings
  add constraint replenishment_settings_max_covers_window
    check (max_coverage_days is null
           or max_coverage_days >= lead_time_days + target_coverage_days + safety_stock_days);

comment on column public.replenishment_settings.max_coverage_days is
  'O "buffer maximo" do PRD (D-148): cobertura em dias acima disso classifica o SKU como EXCESSO. Nulo = o ADMIN ainda nao definiu o que e "demais", e o estado EXCESSO nunca e afirmado. O CHECK replenishment_settings_max_covers_window garante teto >= prazo + cobertura + seguranca -- abaixo da janela, ADEQUADA seria impossivel.';
