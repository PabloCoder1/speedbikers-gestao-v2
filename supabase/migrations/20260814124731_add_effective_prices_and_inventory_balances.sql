-- ============================================================
-- Speed Bikers Gestão V2
--
-- Foundations for effective price tracking and physical
-- inventory balances.
--
-- ml_offer_price_states holds the CURRENT price state of each
-- offer (listing or variation): base price today, effective
-- price (after promotions) once promotion sync exists.
--
-- product_inventory_balances holds physical stock at the
-- canonical SKU level, preserving the central-product
-- architecture already used by `products` instead of tying
-- physical stock to a specific MLB.
-- ============================================================


-- ============================================================
-- 1. ML OFFER PRICE STATES
-- ============================================================

create table public.ml_offer_price_states (

  id uuid primary key
    default gen_random_uuid(),

  organization_id uuid not null,

  ml_account_id uuid not null,

  ml_listing_id uuid not null,

  ml_listing_variation_id uuid,

  product_id uuid,

  offer_scope text not null
    check (
      offer_scope in (
        'listing',
        'variation'
      )
    ),

  item_id text not null,

  variation_id text,

  seller_sku text,

  currency_id text,

  /*
   * Preço base: o preço publicado no anúncio,
   * sem considerar promoções.
   */
  base_price numeric(18, 2),

  /*
   * Preço final: o preço efetivamente cobrado do
   * comprador, incluindo promoções ativas.
   *
   * Enquanto a sincronização de promoções não existe,
   * este campo é preenchido com o mesmo valor de
   * base_price.
   */
  effective_price numeric(18, 2),

  has_active_promotion boolean not null
    default false,

  captured_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  source_sync_run_id uuid,


  -- ----------------------------------------------------------
  -- RELATIONSHIPS
  -- ----------------------------------------------------------

  constraint ml_offer_price_states_listing_fk
    foreign key (
      organization_id,
      ml_account_id,
      ml_listing_id
    )
    references public.ml_listings (
      organization_id,
      ml_account_id,
      id
    )
    on delete cascade,


  constraint ml_offer_price_states_variation_fk
    foreign key (
      ml_listing_variation_id
    )
    references public.ml_listing_variations (
      id
    )
    on delete cascade,


  constraint ml_offer_price_states_product_fk
    foreign key (
      organization_id,
      product_id
    )
    references public.products (
      organization_id,
      id
    )
    on delete set null,


  constraint ml_offer_price_states_sync_run_fk
    foreign key (
      source_sync_run_id
    )
    references public.sync_runs (
      id
    )
    on delete set null,


  -- ----------------------------------------------------------
  -- SCOPE CONSISTENCY
  -- ----------------------------------------------------------

  constraint ml_offer_price_states_scope_check
    check (

      (
        offer_scope = 'listing'

        and
        ml_listing_variation_id
          is null

        and
        variation_id
          is null
      )

      or

      (
        offer_scope = 'variation'

        and
        ml_listing_variation_id
          is not null

        and
        variation_id
          is not null
      )

    )
);


comment on table
public.ml_offer_price_states
is
'Current base/effective price state of Mercado Livre listings and variations, used for price divergence diagnostics.';


-- One current price row per listing (listing-scoped offers).
create unique index
ml_offer_price_states_listing_unique_idx
on public.ml_offer_price_states (
  ml_listing_id
)
where
  offer_scope = 'listing';


-- One current price row per variation (variation-scoped offers).
create unique index
ml_offer_price_states_variation_unique_idx
on public.ml_offer_price_states (
  ml_listing_variation_id
)
where
  ml_listing_variation_id
    is not null;


create index
ml_offer_price_states_product_idx
on public.ml_offer_price_states (
  product_id
)
where
  product_id
    is not null;


create index
ml_offer_price_states_account_idx
on public.ml_offer_price_states (
  ml_account_id
);


create trigger
ml_offer_price_states_set_updated_at
before update on public.ml_offer_price_states
for each row
execute function
private.set_updated_at();


-- ============================================================
-- 2. PRODUCT INVENTORY BALANCES
-- ============================================================

create table public.product_inventory_balances (

  id uuid primary key
    default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  product_id uuid not null,

  /*
   * NULL = saldo consolidado do SKU, independente de canal.
   *
   * Preenchido = saldo específico observado através de uma
   * conta/canal Mercado Livre.
   */
  ml_account_id uuid,

  quantity integer not null
    default 0
    check (
      quantity >= 0
    ),

  reserved_quantity integer not null
    default 0
    check (
      reserved_quantity >= 0
    ),

  source text not null
    default 'manual'
    check (
      char_length(
        btrim(source)
      )
      between 1 and 60
    ),

  captured_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),


  -- ----------------------------------------------------------
  -- RELATIONSHIPS
  -- ----------------------------------------------------------

  constraint product_inventory_balances_product_fk
    foreign key (
      organization_id,
      product_id
    )
    references public.products (
      organization_id,
      id
    )
    on delete cascade,


  constraint product_inventory_balances_account_fk
    foreign key (
      organization_id,
      ml_account_id
    )
    references public.ml_accounts (
      organization_id,
      id
    )
    on delete cascade
);


comment on table
public.product_inventory_balances
is
'Physical inventory balances scoped to the canonical product (SKU), optionally broken down per Mercado Livre account/channel.';


-- One consolidated (account-agnostic) balance per product.
create unique index
product_inventory_balances_consolidated_unique_idx
on public.product_inventory_balances (
  organization_id,
  product_id
)
where
  ml_account_id
    is null;


-- One balance per product per account/channel.
create unique index
product_inventory_balances_account_unique_idx
on public.product_inventory_balances (
  organization_id,
  product_id,
  ml_account_id
)
where
  ml_account_id
    is not null;


create index
product_inventory_balances_product_idx
on public.product_inventory_balances (
  product_id
);


create trigger
product_inventory_balances_set_updated_at
before update on public.product_inventory_balances
for each row
execute function
private.set_updated_at();


-- ============================================================
-- 3. RLS
-- ============================================================


alter table
public.ml_offer_price_states
enable row level security;




alter table
public.product_inventory_balances
enable row level security;




revoke all
on public.ml_offer_price_states
from anon;




revoke all
on public.ml_offer_price_states
from authenticated;




revoke all
on public.product_inventory_balances
from anon;




revoke all
on public.product_inventory_balances
from authenticated;




grant select
on public.ml_offer_price_states
to authenticated;




grant select
on public.product_inventory_balances
to authenticated;




create policy
"users can view permitted offer prices"
on public.ml_offer_price_states
for select
to authenticated


using (
  private.can_access_ml_account(
    ml_account_id
  )
);




create policy
"organization members can view inventory balances"
on public.product_inventory_balances
for select
to authenticated


using (


  private.is_organization_member(
    organization_id
  )


  and


  (
    ml_account_id is null


    or


    private.can_access_ml_account(
      ml_account_id
    )
  )


);
