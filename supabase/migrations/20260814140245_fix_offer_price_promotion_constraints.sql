-- ============================================================


-- ============================================================
-- NUMERIC VALIDATION
-- ============================================================


alter table
public.ml_offer_price_states


add constraint
ml_offer_price_states_promotion_original_price_check


check (
  promotion_original_price is null
  or
  promotion_original_price >= 0
);




alter table
public.ml_offer_price_states


add constraint
ml_offer_price_states_seller_percentage_check


check (
  seller_percentage is null
  or
  seller_percentage between 0 and 100
);




alter table
public.ml_offer_price_states


add constraint
ml_offer_price_states_meli_percentage_check


check (
  meli_percentage is null
  or
  meli_percentage between 0 and 100
);




alter table
public.ml_offer_price_states


add constraint
ml_offer_price_states_boost_percentage_check


check (
  discount_meli_boosted_percentage is null
  or
  discount_meli_boosted_percentage between 0 and 100
);




alter table
public.ml_offer_price_states


add constraint
ml_offer_price_states_boost_amount_check


check (
  discount_meli_boosted_amount is null
  or
  discount_meli_boosted_amount >= 0
);
