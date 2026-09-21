-- ============================================================
-- `listings.description_fingerprint` — completa D-390 (analise
-- pos-alteracao editorial): titulo e foto ja emitiam evento de troca;
-- descricao ficava de fora porque `GET /items/{id}` nao traz o campo --
-- e um recurso a parte, `GET /items/{item_id}/description`.
--
-- Contrato confirmado ao vivo em 2026-09-21, conta "Speedbikers (loja 1)"
-- do Dev, item MLB1384467402:
--
--   { "text": "", "plain_text": "A Polia Traseira Completa da TMAC ...",
--     "last_updated": "...", "date_created": "...", "snapshot": {...} }
--
-- `text` veio vazio nos itens testados; `plain_text` tem o conteudo real,
-- e e o unico usado. O TEXTO NUNCA E GRAVADO -- nem aqui, nem no evento
-- `listing.description.changed`: a coluna guarda so um hash SHA-256, o
-- suficiente para detectar "mudou" sem duplicar o conteudo editorial do
-- vendedor no banco (mesmo raciocinio do fingerprint de fotos, D-317/D-390).
-- ============================================================

alter table public.listings
  add column description_fingerprint text;

alter table public.listings
  add column description_source_updated_at timestamptz;

comment on column public.listings.description_fingerprint is
  'Hash SHA-256 da descricao do anuncio (GET /items/{id}/description, plain_text), usado so para detectar troca editorial. NULO sem descricao propria lida ainda -- nunca o texto em si.';

comment on column public.listings.description_source_updated_at is
  'last_updated do item quando a descricao foi lida; evita chamar GET /items/{id}/description a cada sincronizacao sem mudanca.';
