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


type SnapshotRow = {
  id: string;

  ml_account_id: string;

  ml_listing_id: string;

  ml_listing_variation_id:
    | string
    | null;

  captured_at: string;

  item_id: string;

  variation_id:
    | string
    | null;

  offer_scope:
    | "listing"
    | "variation";

  seller_sku:
    | string
    | null;

  title:
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

  health:
    | number
    | string
    | null;

  catalog_listing:
    | boolean
    | null;

  is_current: boolean;

  source: string;
};


export type OfferHistoryChange =
  | {
      type: "price_changed";
      from: number | null;
      to: number | null;
    }
  | {
      type: "stock_changed";
      from: number;
      to: number;
    }
  | {
      type: "stock_zeroed";
      from: number;
      to: number;
    }
  | {
      type: "stock_restored";
      from: number;
      to: number;
    }
  | {
      type: "status_changed";
      from: string | null;
      to: string | null;
    }
  | {
      type: "health_changed";
      from: number | null;
      to: number | null;
    }
  | {
      type: "catalog_changed";
      from: boolean;
      to: boolean;
    }
  | {
      type: "title_changed";
      from: string | null;
      to: string | null;
    }
  | {
      type: "listing_no_longer_current";
      from: boolean;
      to: boolean;
    };


export type OfferHistoryEvent = {
  snapshotId: string;

  capturedAt: string;

  accountId: string;
  accountCode: string;
  accountName: string;

  itemId: string;
  variationId:
    | string
    | null;

  offerScope:
    | "listing"
    | "variation";

  sellerSku:
    | string
    | null;

  title:
    | string
    | null;

  status:
    | string
    | null;

  price: number | null;

  availableQuantity: number;

  health: number | null;

  catalogListing: boolean;

  isCurrent: boolean;

  source: string;

  changes: OfferHistoryChange[];
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


function getOfferKey(
  snapshot: SnapshotRow,
) {
  return [
    snapshot.offer_scope,
    snapshot
      .ml_listing_variation_id ??
      snapshot.ml_listing_id,
  ].join(":");
}


// ==========================================================
// DETECT CHANGES
//
// Compares a snapshot against the previous snapshot for the
// SAME offer (same listing or same variation).
//
// This only states OBSERVED facts. It never infers cause.
// ==========================================================

function detectOfferChanges(
  previous: SnapshotRow | null,
  current: SnapshotRow,
): OfferHistoryChange[] {
  if (!previous) {
    return [];
  }

  const changes: OfferHistoryChange[] =
    [];


  const previousPrice =
    numericOrNull(
      previous.price,
    );

  const currentPrice =
    numericOrNull(
      current.price,
    );

  if (
    previousPrice !==
    currentPrice
  ) {
    changes.push({
      type: "price_changed",
      from: previousPrice,
      to: currentPrice,
    });
  }


  const previousQuantity =
    previous
      .available_quantity ??
    0;

  const currentQuantity =
    current
      .available_quantity ??
    0;

  if (
    previousQuantity !==
    currentQuantity
  ) {
    changes.push({
      type: "stock_changed",
      from: previousQuantity,
      to: currentQuantity,
    });

    if (
      previousQuantity > 0 &&
      currentQuantity === 0
    ) {
      changes.push({
        type: "stock_zeroed",
        from: previousQuantity,
        to: currentQuantity,
      });
    } else if (
      previousQuantity === 0 &&
      currentQuantity > 0
    ) {
      changes.push({
        type: "stock_restored",
        from: previousQuantity,
        to: currentQuantity,
      });
    }
  }


  if (
    previous.status !==
    current.status
  ) {
    changes.push({
      type: "status_changed",
      from: previous.status,
      to: current.status,
    });
  }


  const previousHealth =
    numericOrNull(
      previous.health,
    );

  const currentHealth =
    numericOrNull(
      current.health,
    );

  if (
    previousHealth !==
    currentHealth
  ) {
    changes.push({
      type: "health_changed",
      from: previousHealth,
      to: currentHealth,
    });
  }


  const previousCatalog =
    previous
      .catalog_listing ??
    false;

  const currentCatalog =
    current
      .catalog_listing ??
    false;

  if (
    previousCatalog !==
    currentCatalog
  ) {
    changes.push({
      type: "catalog_changed",
      from: previousCatalog,
      to: currentCatalog,
    });
  }


  if (
    previous.title !==
    current.title
  ) {
    changes.push({
      type: "title_changed",
      from: previous.title,
      to: current.title,
    });
  }


  if (
    previous.is_current &&
    !current.is_current
  ) {
    changes.push({
      type:
        "listing_no_longer_current",
      from: true,
      to: false,
    });
  }


  return changes;
}


export async function getProductOfferHistory({
  productId,
  limit = 100,
}: {
  productId: string;
  limit?: number;
}) {
  const access =
    await getCurrentAccess();

  if (!access) {
    return {
      totalSnapshots:
        0,

      events:
        [] as OfferHistoryEvent[],
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
  // SNAPSHOTS DO PRODUTO
  //
  // Ordenados do mais antigo para o mais novo, para permitir
  // comparação sequencial por oferta.
  // ==========================================================

  const {
    data:
      snapshotData,

    error:
      snapshotError,
  } = await supabase
    .from(
      "ml_offer_state_snapshots",
    )
    .select(
      [
        "id",
        "ml_account_id",
        "ml_listing_id",
        "ml_listing_variation_id",
        "captured_at",
        "item_id",
        "variation_id",
        "offer_scope",
        "seller_sku",
        "title",
        "status",
        "price",
        "available_quantity",
        "health",
        "catalog_listing",
        "is_current",
        "source",
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
    .order(
      "captured_at",
      {
        ascending:
          true,
      },
    )
    .returns<
      SnapshotRow[]
    >();


  if (snapshotError) {
    throw new Error(
      "Não foi possível carregar o histórico de estados do anúncio.",
    );
  }


  const snapshots =
    snapshotData ??
    [];


  // ==========================================================
  // MONTAGEM DOS EVENTOS
  //
  // Para cada oferta (anúncio ou variação), comparamos cada
  // snapshot com o snapshot imediatamente anterior DA MESMA
  // oferta.
  // ==========================================================

  const lastSnapshotByOfferKey =
    new Map<
      string,
      SnapshotRow
    >();

  const events:
    OfferHistoryEvent[] =
    [];


  for (
    const snapshot
    of snapshots
  ) {
    const account =
      accountById.get(
        snapshot
          .ml_account_id,
      );


    if (!account) {
      continue;
    }


    const offerKey =
      getOfferKey(
        snapshot,
      );

    const previous =
      lastSnapshotByOfferKey.get(
        offerKey,
      ) ??
      null;

    const changes =
      detectOfferChanges(
        previous,
        snapshot,
      );

    lastSnapshotByOfferKey.set(
      offerKey,
      snapshot,
    );


    events.push({
      snapshotId:
        snapshot.id,


      capturedAt:
        snapshot
          .captured_at,


      accountId:
        account.id,


      accountCode:
        account.code,


      accountName:
        account
          .display_name,


      itemId:
        snapshot.item_id,


      variationId:
        snapshot
          .variation_id,


      offerScope:
        snapshot
          .offer_scope,


      sellerSku:
        snapshot
          .seller_sku,


      title:
        snapshot.title,


      status:
        snapshot.status,


      price:
        numericOrNull(
          snapshot.price,
        ),


      availableQuantity:
        snapshot
          .available_quantity ??
        0,


      health:
        numericOrNull(
          snapshot.health,
        ),


      catalogListing:
        snapshot
          .catalog_listing ??
        false,


      isCurrent:
        snapshot
          .is_current,


      source:
        snapshot.source,


      changes,
    });
  }


  // ==========================================================
  // UI WANTS NEWEST FIRST
  // ==========================================================


  events.sort(
    (
      left,
      right,
    ) =>
      new Date(
        right.capturedAt,
      ).getTime() -
      new Date(
        left.capturedAt,
      ).getTime(),
  );


  return {
    totalSnapshots:
      snapshots.length,


    events:
      events.slice(
        0,
        limit,
      ),
  };
}
