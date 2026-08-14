-- ============================================================
-- Speed Bikers Gestão V2
--
-- Final promotion state consistency constraints.
-- ============================================================




alter table
public.ml_offer_price_states


add constraint
ml_offer_price_states_promotion_resolution_check


check (
  promotion_resolution in (
    'not_checked',
    'no_active_promotion',
    'active_promotion',
    'active_promotion_without_price',
    'ambiguous_multiple_active_prices'
  )
);




alter table
public.ml_offer_price_states


add constraint
ml_offer_price_states_promotion_active_consistency_check


check (


  promotion_resolution = 'not_checked'


  or


  (
    promotion_resolution = 'no_active_promotion'
    and
    has_active_promotion = false
  )


  or


  (
    promotion_resolution in (
      'active_promotion',
      'active_promotion_without_price',
      'ambiguous_multiple_active_prices'
    )
    and
    has_active_promotion = true
  )


);
