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

        advertisedStock:
          0,

        accounts:
          0,

        catalogOffers:
          0,
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

    price:
      | number
      | null;

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

      price:
        numericOrNull(
          listing.price,
        ),

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

      price:
        numericOrNull(
          variation.price ??
          parent.price,
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


  const summary = {
    mlbs:
      distinctMlbs.size,

    offers:
      listings.length,

    activeOffers:
      listings.filter(
        (listing) =>
          listing.status ===
          "active",
      ).length,

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
  };


  return {
    listings,
    summary,
  };
}
