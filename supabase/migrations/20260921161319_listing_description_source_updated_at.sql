-- ============================================================
-- `listings.description_source_updated_at` — completa D-390.
--
-- Guarda o `last_updated` do item do Mercado Livre no momento em que a
-- descrição foi lida (`GET /items/{item_id}/description`). Sem isto, o
-- worker chamaria o endpoint de descrição para TODO anúncio ativo a cada
-- sincronização (6h), mesmo nos que nunca mudam: `ml-listings-fetch.ts`
-- só rechama quando `item.last_updated` diverge do que está gravado aqui.
-- ============================================================

alter table public.listings
  add column description_source_updated_at timestamptz;

comment on column public.listings.description_source_updated_at is
  'last_updated do item quando a descricao foi lida; evita chamar GET /items/{id}/description a cada sincronizacao sem mudanca.';
