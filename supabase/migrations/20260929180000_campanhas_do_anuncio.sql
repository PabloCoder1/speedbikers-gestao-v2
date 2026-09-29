-- ============================================================
-- D-420 -- as CAMPANHAS de cada anuncio: a no ar e as que ele pode entrar.
--
-- O filtro de D-419 separa os anuncios ativos em promocao dos que nao estao,
-- e o dono quer isso "para colocarmos". O passo seguinte e saber EM QUE: a
-- mesma resposta de `GET /seller-promotions/items/{id}` que o worker ja le
-- traz as campanhas `candidate` -- as que o vendedor pode ativar --, e o
-- worker as jogava fora.
--
-- MEDIDO na sonda de 29/09 (so GET, rodada pelo dono; 44 anuncios ativos das
-- quatro contas): os 32 sem preco promocional vieram TODOS com candidatas
-- (200, nenhum 403). Tipos oferecidos: desconto no preco (todos), campanha do
-- Mercado Livre (DEAL), campanha e cupom do vendedor, oferta relampago,
-- co-participada (SMART) e liquidacao de estoque Full. Cada candidata traz o
-- que a tela precisa: nome, periodo, o preco que o Mercado Livre sugere com a
-- faixa aceita e, na co-participada, quanto do desconto cada um paga.
--
--   promotions   lista das campanhas no ar e candidatas da ULTIMA leitura boa
--                (a mesma de `in_promotion`); NULO = nao lido
--
-- Projecao, reescrita a cada sincronizacao do catalogo (6 h); leitura que
-- falha mantem a anterior (D-419). So anuncio ativo e lido.
-- ============================================================

alter table public.listings
  add column if not exists promotions jsonb;

comment on column public.listings.promotions is
  'Campanhas do Mercado Livre deste anuncio na ultima leitura BOA (D-420): as no ar (status "started") e as que ele pode entrar ("candidate"), com nome, periodo, preco sugerido e faixa, e a participacao do Mercado Livre na co-participada. NULO = nao lido; leitura que falha mantem a anterior.';

-- Lista ou nulo: a tela le com `jsonb_array_elements`, e um objeto solto la
-- dentro viraria erro de leitura em vez de "sem campanha".
alter table public.listings
  add constraint listings_promotions_lista
  check (promotions is null or jsonb_typeof(promotions) = 'array') not valid;

alter table public.listings validate constraint listings_promotions_lista;
