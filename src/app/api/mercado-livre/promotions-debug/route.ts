import {
  NextResponse,
  type NextRequest,
} from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import {
  isMercadoLivreAppCode,
} from "@/integrations/mercado-livre/config";
import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import { getMercadoLivreCurrentUser } from "@/integrations/mercado-livre/users";
import {
  getMercadoLivreItemPromotions,
  resolveMercadoLivrePromotionState,
} from "@/integrations/mercado-livre/promotions";
import { createAdminClient } from "@/lib/supabase/admin";

type MercadoLivreAccountRow = {
  id: string;
  code: string;
  display_name: string | null;
  seller_id: string | null;
  connection_status: string;
};

type MercadoLivreListingRow = {
  item_id: string;
  title: string | null;
  seller_sku: string | null;
  price: number | string | null;
  status: string | null;
};

export async function GET(
  request: NextRequest,
) {
  const access =
    await getCurrentAccess();

  if (!access) {
    return NextResponse.json(
      {
        error:
          "not_authenticated",
      },
      {
        status: 401,
      },
    );
  }

  if (
    access.role !== "admin"
  ) {
    return NextResponse.json(
      {
        error:
          "not_authorized",
      },
      {
        status: 403,
      },
    );
  }

  const accountCode =
    request.nextUrl.searchParams.get(
      "account",
    );

  if (
    !accountCode ||
    !isMercadoLivreAppCode(
      accountCode,
    )
  ) {
    return NextResponse.json(
      {
        error:
          "invalid_account",
      },
      {
        status: 400,
      },
    );
  }

  const rawItemId =
    request.nextUrl.searchParams.get(
      "item",
    );

  if (!rawItemId) {
    return NextResponse.json(
      {
        error:
          "invalid_item",
      },
      {
        status: 400,
      },
    );
  }

  const admin =
    createAdminClient();

  const {
    data: account,
    error: accountError,
  } = await admin
    .from("ml_accounts")
    .select(
      [
        "id",
        "code",
        "display_name",
        "seller_id",
        "connection_status",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "code",
      accountCode,
    )
    .maybeSingle<MercadoLivreAccountRow>();

  if (
    accountError ||
    !account
  ) {
    return NextResponse.json(
      {
        error:
          "account_not_found",
      },
      {
        status: 404,
      },
    );
  }

  const typedAccount =
    account as MercadoLivreAccountRow;

  if (
    typedAccount.connection_status !==
    "connected"
  ) {
    return NextResponse.json(
      {
        error:
          "account_not_connected",

        status:
          typedAccount.connection_status,
      },
      {
        status: 409,
      },
    );
  }

  // ==========================================================
  // O MLB precisa pertencer À CONTA informada.
  //
  // Primeiro provamos organização → conta → MLB dessa conta,
  // e só depois chamamos o Mercado Livre.
  // ==========================================================

  const {
    data: listing,
    error: listingError,
  } = await admin
    .from("ml_listings")
    .select(
      [
        "item_id",
        "title",
        "seller_sku",
        "price",
        "status",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "ml_account_id",
      typedAccount.id,
    )
    .eq(
      "item_id",
      rawItemId,
    )
    .maybeSingle<MercadoLivreListingRow>();

  if (
    listingError ||
    !listing
  ) {
    return NextResponse.json(
      {
        error: "listing_not_found_for_account",
      },
      {
        status: 404,
      },
    );
  }


  try {
    const validToken =
      await getValidMercadoLivreAccessToken(
        typedAccount.id,
      );


    const seller =
      await getMercadoLivreCurrentUser(
        validToken.accessToken,
      );


    if (
      typedAccount.seller_id !==
      seller.id
    ) {
      return NextResponse.json(
        {
          error: "seller_mismatch",
        },
        {
          status: 409,
        },
      );
    }


    const promotions =
      await getMercadoLivreItemPromotions({
        itemId: rawItemId,
        accessToken:
          validToken.accessToken,
      });


    const parsedBasePrice =
      listing.price === null
        ? null
        : Number(
            listing.price,
          );


    const basePrice =
      parsedBasePrice !== null &&
      Number.isFinite(
        parsedBasePrice,
      )
        ? parsedBasePrice
        : null;


    const resolved =
      resolveMercadoLivrePromotionState({
        basePrice,
        payload:
          promotions,
      });


    return NextResponse.json({
      ok: true,


      account: {
        code: typedAccount.code,
        displayName:
          typedAccount.display_name,
        sellerId:
          typedAccount.seller_id,
        sellerNickname:
          seller.nickname,
      },


      listing: {
        itemId: listing.item_id,
        title: listing.title,
        sellerSku:
          listing.seller_sku,
        basePrice:
          listing.price,
        status: listing.status,
      },


      promotions,


      resolved,
    });
  } catch (error) {
    console.error(
      "Mercado Livre promotions debug failed:",
      error instanceof Error
        ? error.message
        : "unknown error",
    );


    return NextResponse.json(
      {
        error:
          "mercado_livre_promotions_debug_failed",


        message:
          error instanceof Error
            ? error.message
            : "Erro desconhecido.",
      },
      {
        status: 500,
      },
    );
  }
}
