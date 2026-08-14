-- ============================================================


alter table
public.ml_offer_price_states


add column
promotion_resolution text not null
default 'not_checked',


add column
promotion_id text,


add column
promotion_type text,


add column
promotion_sub_type text,


add column
promotion_ref_id text,


add column
promotion_status text,


add column
promotion_name text,


add column
promotion_original_price numeric(18, 2),


add column
seller_percentage numeric,


add column
meli_percentage numeric,


add column
boosted_offer boolean,


add column
discount_meli_boosted_percentage numeric,


add column
discount_meli_boosted_amount numeric(18, 2),


add column
total_price_for_boosted_offer numeric(18, 2),


add column
promotion_started_at timestamptz,


add column
promotion_ends_at timestamptz,


add column
promotion_deadline_at timestamptz,


add column
promotion_checked_at timestamptz,


add column
active_promotion_payload jsonb,


add column
active_promotion_details_payload jsonb;




-- ============================================================


alter table
public.ml_offer_price_states


add constraint
ml_offer_price_states_boost_total_price_check


check (
  total_price_for_boosted_offer is null
  or
  total_price_for_boosted_offer >= 0
);




-- ============================================================
-- INDEXES
-- ============================================================


create index
ml_offer_price_states_promotion_resolution_idx


on public.ml_offer_price_states (
  promotion_resolution
);




create index
ml_offer_price_states_active_promotion_ends_idx


on public.ml_offer_price_states (
  promotion_ends_at
)


where
  has_active_promotion = true
  and
  promotion_ends_at is not null;




create index
ml_offer_price_states_promotion_id_idx


on public.ml_offer_price_states (
  promotion_id
)


where
  promotion_id is not null;




-- ============================================================
-- COMMENTS
-- ============================================================


comment on column
public.ml_offer_price_states.promotion_resolution
is
'Current deterministic resolution of the Mercado Livre promotion lookup. not_checked is intentionally different from no_active_promotion.';




comment on column
public.ml_offer_price_states.promotion_checked_at
is
'Timestamp of the most recent successful promotion lookup for this offer.';




comment on column
public.ml_offer_price_states.active_promotion_payload
is
'Raw active promotion item payload returned by Mercado Livre for observability and future compatibility.';




comment on column
public.ml_offer_price_states.active_promotion_details_payload
is
'Raw promotion details payload returned by Mercado Livre when additional campaign details were queried.';
