import "server-only";

import {
  getCurrentAccess,
} from "@/features/auth/get-current-access";

import {
  createClient,
} from "@/lib/supabase/server";


type AccountRow = {
  id: string;
  code: string;
  display_name: string;
};


type ListingRow = {
  id: string;

  ml_account_id: string;
  product_id: string | null;

  item_id: string;

  title: string | null;
  seller_sku: string | null;

  listing_type_id:
    | string
    | null;

  status:
    | string
    | null;

  price:
    | number
    | string
    | null;

  available_quantity:
    | number
    | null;

  sold_quantity:
    | number
    | null;

  health:
    | number
    | string
    | null;

  catalog_listing:
    | boolean
    | null;

  permalink:
    | string
    | null;

  thumbnail:
    | string
    | null;

  is_current:
    boolean;

  ml_last_updated:
    | string
    | null;
};


type VariationRow = {
  id: string;

  ml_account_id: string;
  ml_listing_id: string;

  product_id:
    | string
    | null;

  variation_id: string;

  seller_sku:
    | string
    | null;

  price:
    | number
    | string
    | null;

  available_quantity:
    | number
    | null;

  sold_quantity:
    | number
    | null;

  is_current:
    boolean;
};


type PriceStateRow = {
  ml_listing_id: string;
  base_price: number | string | null;
  effective_price: number | string | null;
  has_active_promotion: boolean;
  promotion_resolution: string | null;
  promotion_id: string | null;
  promotion_type: string | null;
  promotion_sub_type: string | null;
  promotion_name: string | null;
  promotion_status: string | null;
  promotion_match_method: string | null;
  promotion_started_at: string | null;
  promotion_ends_at: string | null;
  price_checked_at: string | null;
  promotions_fetch_status: string;
};


type PriceScope =
  | "listing_validated"
  | "listing_pending"
  | "variation_unvalidated";


type ListingPriceModel = {
  legacyPrice: number | null;
  priceReady: boolean;
  basePrice: number | null;
  effectivePrice: number | null;
  displayPrice: number | null;
  discountPercent: number | null;
  hasActivePromotion: boolean;
  promotionType: string | null;
  promotionName: string | null;
  promotionResolution: string | null;
  priceCheckedAt: string | null;
  priceScope: PriceScope;
};


function numericOrNull(
  value:
    | number
    | string
    | null
    | undefined,
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const parsed =
    Number(
      value,
    );

  return Number.isFinite(
    parsed,
  )
    ? parsed
    : null;
}


function listingPriceModel({
  legacyPrice,
  state,
}: {
  legacyPrice: number | null;
  state: PriceStateRow | undefined;
}): ListingPriceModel {
  const basePrice = numericOrNull(state?.base_price);
  const effectivePrice = numericOrNull(state?.effective_price);
  const priceReady = Boolean(
    state &&
    basePrice !== null &&
    effectivePrice !== null &&
    state.price_checked_at,
  );
  const discountPercent =
    priceReady &&
    basePrice !== null &&
    basePrice > 0 &&
    effectivePrice !== null &&
    effectivePrice < basePrice
      ? Math.round((((basePrice - effectivePrice) / basePrice) * 100) * 100) / 100
      : null;

  return {
    legacyPrice,
    priceReady,
    basePrice: priceReady ? basePrice : null,
    effectivePrice: priceReady ? effectivePrice : null,
    displayPrice: priceReady ? effectivePrice : legacyPrice,
    discountPercent,
    hasActivePromotion: priceReady ? state?.has_active_promotion ?? false : false,
    promotionType: priceReady ? state?.promotion_type ?? null : null,
    promotionName: priceReady ? state?.promotion_name ?? null : null,
    promotionResolution: priceReady ? state?.promotion_resolution ?? null : null,
    priceCheckedAt: state?.price_checked_at ?? null,
    priceScope: priceReady ? "listing_validated" : "listing_pending",
  };
}


function variationPriceModel(legacyPrice: number | null): ListingPriceModel {
  return {
    legacyPrice,
    priceReady: false,
    basePrice: null,
    effectivePrice: null,
    displayPrice: legacyPrice,
    discountPercent: null,
    hasActivePromotion: false,
    promotionType: null,
    promotionName: null,
    promotionResolution: null,
    priceCheckedAt: null,
    priceScope: "variation_unvalidated",
  };
}


export async function getProductListings({
  productId,
}: {
  productId: string;
}) {
  const access =
    await getCurrentAccess();

  if (!access) {
    return {
      listings: [],
      summary: {
        mlbs:
          0,


        offers:
          0,


        activeOffers:
          0,


        pausedOffers:
          0,


        zeroStockOffers:
          0,


        advertisedStock:
          0,


        accounts:
          0,


        catalogOffers:
          0,


        validatedPriceOffers:
          0,


        pendingPriceOffers:
          0,


        variationPriceOffers:
          0,


        effectiveMinimumPrice:
          null,


        effectiveMaximumPrice:
          null,


        effectivePriceSpreadPercent:
          null,


        baseMinimumPrice:
          null,


        baseMaximumPrice:
          null,


        lowestEffectiveListingIds:
          [] as string[],


        averageHealth:
          null,


        minimumHealth:
          null,
      },
    };
  }


  const supabase =
    await createClient();


  // ==========================================================
  // CONTAS DISPONÍVEIS
  //
  // A consulta respeita RLS.
  // ==========================================================

  const {
    data:
      accountData,

    error:
      accountError,
  } = await supabase
    .from(
      "ml_accounts",
    )
    .select(
      [
        "id",
        "code",
        "display_name",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "is_active",
      true,
    )
    .returns<
      AccountRow[]
    >();


  if (accountError) {
    throw new Error(
      "Não foi possível carregar as contas dos anúncios.",
    );
  }


  const accountById =
    new Map(
      (
        accountData ??
        []
      ).map(
        (account) => [
          account.id,
          account,
        ],
      ),
    );


  // ==========================================================
  // ANÚNCIOS DIRETAMENTE VINCULADOS AO PRODUTO
  // ==========================================================

  const {
    data:
      directListingData,

    error:
      directListingError,
  } = await supabase
    .from(
      "ml_listings",
    )
    .select(
      [
        "id",
        "ml_account_id",
        "product_id",
        "item_id",
        "title",
        "seller_sku",
        "listing_type_id",
        "status",
        "price",
        "available_quantity",
        "sold_quantity",
        "health",
        "catalog_listing",
        "permalink",
        "thumbnail",
        "is_current",
        "ml_last_updated",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "product_id",
      productId,
    )
    .eq(
      "is_current",
      true,
    )
    .returns<
      ListingRow[]
    >();


  if (directListingError) {
    throw new Error(
      "Não foi possível carregar os anúncios vinculados ao produto.",
    );
  }


  // ==========================================================
  // VARIAÇÕES VINCULADAS AO PRODUTO
  //
  // Uma variação pode carregar SKU próprio.
  // ==========================================================

  const {
    data:
      variationData,

    error:
      variationError,
  } = await supabase
    .from(
      "ml_listing_variations",
    )
    .select(
      [
        "id",
        "ml_account_id",
        "ml_listing_id",
        "product_id",
        "variation_id",
        "seller_sku",
        "price",
        "available_quantity",
        "sold_quantity",
        "is_current",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "product_id",
      productId,
    )
    .eq(
      "is_current",
      true,
    )
    .returns<
      VariationRow[]
    >();


  if (variationError) {
    throw new Error(
      "Não foi possível carregar as variações vinculadas ao produto.",
    );
  }


  const directListings =
    directListingData ??
    [];

  const variations =
    variationData ??
    [];


  // ==========================================================
  // BUSCAR ANÚNCIOS-PAI DAS VARIAÇÕES
  // ==========================================================

  const parentListingIds =
    Array.from(
      new Set(
        variations.map(
          (variation) =>
            variation
              .ml_listing_id,
        ),
      ),
    );


  let parentListings:
    ListingRow[] =
    [];


  if (
    parentListingIds.length >
    0
  ) {
    const {
      data:
        parentListingData,

      error:
        parentListingError,
    } = await supabase
      .from(
        "ml_listings",
      )
      .select(
        [
          "id",
          "ml_account_id",
          "product_id",
          "item_id",
          "title",
          "seller_sku",
          "listing_type_id",
          "status",
          "price",
          "available_quantity",
          "sold_quantity",
          "health",
          "catalog_listing",
          "permalink",
          "thumbnail",
          "is_current",
          "ml_last_updated",
        ].join(","),
      )
      .eq(
        "organization_id",
        access.organizationId,
      )
      .eq(
        "is_current",
        true,
      )
      .in(
        "id",
        parentListingIds,
      )
      .returns<
        ListingRow[]
      >();


    if (
      parentListingError
    ) {
      throw new Error(
        "Não foi possível carregar os anúncios das variações.",
      );
    }


    parentListings =
      parentListingData ??
      [];
  }


  const involvedListingIds = Array.from(
    new Set([
      ...directListings.map((listing) => listing.id),
      ...parentListings.map((listing) => listing.id),
    ]),
  );

  let priceStates: PriceStateRow[] = [];

  if (involvedListingIds.length > 0) {
    const { data: priceStateData, error: priceStateError } = await supabase
      .from("ml_offer_price_states")
      .select(
        [
          "ml_listing_id",
          "base_price",
          "effective_price",
          "has_active_promotion",
          "promotion_resolution",
          "promotion_id",
          "promotion_type",
          "promotion_sub_type",
          "promotion_name",
          "promotion_status",
          "promotion_match_method",
          "promotion_started_at",
          "promotion_ends_at",
          "price_checked_at",
          "promotions_fetch_status",
        ].join(","),
      )
      .eq("organization_id", access.organizationId)
      .eq("offer_scope", "listing")
      .in("ml_listing_id", involvedListingIds)
      .returns<PriceStateRow[]>();

    if (priceStateError) {
      throw new Error("Nao foi possivel carregar os precos validados dos anuncios.");
    }

    priceStates = priceStateData ?? [];
  }

  const priceStateByListingId = new Map(
    priceStates.map((state) => [state.ml_listing_id, state]),
  );


  const parentById =
    new Map(
      parentListings.map(
        (listing) => [
          listing.id,
          listing,
        ],
      ),
    );


  // ==========================================================
  // NORMALIZAÇÃO
  //
  // Se um mesmo anúncio possui uma variação deste SKU,
  // preferimos a variação porque ela contém preço e estoque
  // mais específicos.
  // ==========================================================

  const listingsWithMatchingVariation =
    new Set(
      variations.map(
        (variation) =>
          variation
            .ml_listing_id,
      ),
    );


  const listings: Array<{
    key: string;

    listingId: string;

    itemId: string;

    variationId:
      | string
      | null;

    accountId: string;

    accountCode:
      string;

    accountName:
      string;

    title:
      | string
      | null;

    sellerSku:
      | string
      | null;

    listingTypeId:
      | string
      | null;

    status:
      | string
      | null;

    legacyPrice:
      | number
      | null;

    priceReady: boolean;

    basePrice:
      | number
      | null;

    effectivePrice:
      | number
      | null;

    displayPrice:
      | number
      | null;

    discountPercent:
      | number
      | null;

    hasActivePromotion: boolean;

    promotionType:
      | string
      | null;

    promotionName:
      | string
      | null;

    promotionResolution:
      | string
      | null;

    priceCheckedAt:
      | string
      | null;

    priceScope: PriceScope;

    availableQuantity:
      number;

    soldQuantity:
      number;

    health:
      | number
      | null;

    catalogListing:
      boolean;

    permalink:
      | string
      | null;

    thumbnail:
      | string
      | null;

    mlLastUpdated:
      | string
      | null;
  }> = [];


  // ==========================================================
  // LISTAGENS SEM VARIAÇÃO ESPECÍFICA PARA ESTE SKU
  // ==========================================================

  for (
    const listing
    of directListings
  ) {
    if (
      listingsWithMatchingVariation
        .has(
          listing.id,
        )
    ) {
      continue;
    }


    const account =
      accountById.get(
        listing
          .ml_account_id,
      );


    if (!account) {
      continue;
    }


    listings.push({
      key:
        `listing:${listing.id}`,

      listingId:
        listing.id,

      itemId:
        listing.item_id,

      variationId:
        null,

      accountId:
        account.id,

      accountCode:
        account.code,

      accountName:
        account.display_name,

      title:
        listing.title,

      sellerSku:
        listing.seller_sku,

      listingTypeId:
        listing.listing_type_id,

      status:
        listing.status,

      ...listingPriceModel({
        legacyPrice:
          numericOrNull(
            listing.price,
          ),

        state:
          priceStateByListingId.get(
            listing.id,
          ),
      }),

      availableQuantity:
        listing
          .available_quantity ??
        0,

      soldQuantity:
        listing
          .sold_quantity ??
        0,

      health:
        numericOrNull(
          listing.health,
        ),

      catalogListing:
        listing
          .catalog_listing ??
        false,

      permalink:
        listing.permalink,

      thumbnail:
        listing.thumbnail,

      mlLastUpdated:
        listing
          .ml_last_updated,
    });
  }


  // ==========================================================
  // VARIAÇÕES
  // ==========================================================

  for (
    const variation
    of variations
  ) {
    const parent =
      parentById.get(
        variation
          .ml_listing_id,
      );


    if (!parent) {
      continue;
    }


    const account =
      accountById.get(
        variation
          .ml_account_id,
      );


    if (!account) {
      continue;
    }


    listings.push({
      key:
        `variation:${variation.id}`,

      listingId:
        parent.id,

      itemId:
        parent.item_id,

      variationId:
        variation
          .variation_id,

      accountId:
        account.id,

      accountCode:
        account.code,

      accountName:
        account.display_name,

      title:
        parent.title,

      sellerSku:
        variation
          .seller_sku ??
        parent.seller_sku,

      listingTypeId:
        parent
          .listing_type_id,

      status:
        parent.status,

      ...variationPriceModel(
        numericOrNull(
          variation.price ??
          parent.price,
        ),
      ),

      availableQuantity:
        variation
          .available_quantity ??
        parent
          .available_quantity ??
        0,

      soldQuantity:
        variation
          .sold_quantity ??
        parent
          .sold_quantity ??
        0,

      health:
        numericOrNull(
          parent.health,
        ),

      catalogListing:
        parent
          .catalog_listing ??
        false,

      permalink:
        parent.permalink,

      thumbnail:
        parent.thumbnail,

      mlLastUpdated:
        parent
          .ml_last_updated,
    });
  }


  listings.sort(
    (
      left,
      right,
    ) => {
      const leftActive =
        left.status ===
        "active"
          ? 0
          : 1;

      const rightActive =
        right.status ===
        "active"
          ? 0
          : 1;


      if (
        leftActive !==
        rightActive
      ) {
        return (
          leftActive -
          rightActive
        );
      }


      const accountOrder =
        left.accountName
          .localeCompare(
            right.accountName,
            "pt-BR",
          );


      if (
        accountOrder !==
        0
      ) {
        return accountOrder;
      }


      return left.itemId
        .localeCompare(
          right.itemId,
        );
    },
  );


  // ==========================================================
  // SUMMARY
  // ==========================================================

  const distinctMlbs =
    new Set(
      listings.map(
        (listing) =>
          listing.itemId,
      ),
    );


  const accountsWithListings =
    new Set(
      listings.map(
        (listing) =>
          listing.accountId,
      ),
    );


  const activeListings =
    listings.filter(
      (listing) =>
        listing.status ===
        "active",
    );


  const pausedListings =
    listings.filter(
      (listing) =>
        listing.status ===
        "paused",
    );


  const zeroStockListings =
    listings.filter(
      (listing) =>
        listing
          .availableQuantity ===
        0,
    );


  const eligiblePriceListings =
    listings.filter(
      (listing) =>
        listing.variationId ===
        null,
    );


  const validatedPriceOffers =
    eligiblePriceListings.filter(
      (listing) =>
        listing.priceReady,
    ).length;


  const pendingPriceOffers =
    eligiblePriceListings.length -
    validatedPriceOffers;


  const variationPriceOffers =
    listings.length -
    eligiblePriceListings.length;


  const comparableListings =
    eligiblePriceListings.filter(
      (
        listing,
      ): listing is typeof listing & {
        basePrice: number;
        effectivePrice: number;
      } =>
        listing.status ===
          "active" &&
        listing.priceReady &&
        listing.basePrice !==
          null &&
        listing.effectivePrice !==
          null,
    );


  const effectivePrices =
    comparableListings.map(
      (listing) =>
        listing.effectivePrice,
    );


  const basePrices =
    comparableListings.map(
      (listing) =>
        listing.basePrice,
    );


  const effectiveMinimumPrice =
    effectivePrices.length >
    0
      ? Math.min(
          ...effectivePrices,
        )
      : null;


  const effectiveMaximumPrice =
    effectivePrices.length >
    0
      ? Math.max(
          ...effectivePrices,
        )
      : null;


  const effectivePriceSpreadPercent =
    effectiveMinimumPrice !==
      null &&
    effectiveMaximumPrice !==
      null &&
    effectiveMinimumPrice >
      0
      ? (
          (effectiveMaximumPrice -
            effectiveMinimumPrice) /
          effectiveMinimumPrice
        ) *
        100
      : null;


  const baseMinimumPrice =
    basePrices.length >
    0
      ? Math.min(
          ...basePrices,
        )
      : null;


  const baseMaximumPrice =
    basePrices.length >
    0
      ? Math.max(
          ...basePrices,
        )
      : null;


  const lowestEffectiveListingIds =
    effectiveMinimumPrice ===
    null
      ? []
      : comparableListings
          .filter(
            (listing) =>
              Math.round(
                listing.effectivePrice *
                100,
              ) ===
              Math.round(
                effectiveMinimumPrice *
                100,
              ),
          )
          .map(
            (listing) =>
              listing.listingId,
          );


  const validHealthValues =
    listings
      .map(
        (listing) =>
          listing.health,
      )
      .filter(
        (
          health,
        ): health is number =>
          health !== null,
      );


  // ==========================================================


  const averageHealth =
    validHealthValues.length >
    0
      ? (
          validHealthValues.reduce(
            (
              total,
              health,
            ) =>
              total +
              health,

            0,
          ) /
          validHealthValues.length
        )
      : null;


  const minimumHealth =
    validHealthValues.length >
    0
      ? Math.min(
          ...validHealthValues,
        )
      : null;


  const summary = {
    mlbs:
      distinctMlbs.size,


    offers:
      listings.length,


    activeOffers:
      activeListings.length,


    pausedOffers:
      pausedListings.length,


    zeroStockOffers:
      zeroStockListings.length,


    advertisedStock:
      listings.reduce(
        (
          total,
          listing,
        ) =>
          total +
          listing
            .availableQuantity,


        0,
      ),


    accounts:
      accountsWithListings
        .size,


    catalogOffers:
      listings.filter(
        (listing) =>
          listing
            .catalogListing,
      ).length,


    validatedPriceOffers,


    pendingPriceOffers,


    variationPriceOffers,


    effectiveMinimumPrice,


    effectiveMaximumPrice,


    effectivePriceSpreadPercent,


    baseMinimumPrice,


    baseMaximumPrice,


    lowestEffectiveListingIds,


    averageHealth,


    minimumHealth,
  };


  return {
    listings,
    summary,
  };
}
