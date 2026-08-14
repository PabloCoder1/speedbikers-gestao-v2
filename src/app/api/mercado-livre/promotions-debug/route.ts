import { NextResponse, type NextRequest } from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { persistListingPromotionState } from "@/features/ml-sync/persist-listing-promotion-state";
import { resolveListingPriceState } from "@/features/ml-sync/resolve-listing-price-state";
import { getValidMercadoLivreAccessToken } from "@/integrations/mercado-livre/access-token";
import { isMercadoLivreAppCode } from "@/integrations/mercado-livre/config";
import { getMercadoLivreCurrentUser } from "@/integrations/mercado-livre/users";
import { createAdminClient } from "@/lib/supabase/admin";

type AccountRow = {
  id: string;
  code: string;
  display_name: string | null;
  seller_id: string | null;
  connection_status: string;
};
type ListingRow = {
  id: string;
  product_id: string | null;
  item_id: string;
  title: string | null;
  seller_sku: string | null;
  currency_id: string | null;
  price: number | string | null;
  status: string | null;
};

async function handlePromotionsDebug(request: NextRequest, persist: boolean) {
  const access = await getCurrentAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (access.role !== "admin") return NextResponse.json({ error: "not_authorized" }, { status: 403 });

  const accountCode = request.nextUrl.searchParams.get("account");
  if (!accountCode || !isMercadoLivreAppCode(accountCode)) {
    return NextResponse.json({ error: "invalid_account" }, { status: 400 });
  }
  const rawItemId = request.nextUrl.searchParams.get("item");
  if (!rawItemId) return NextResponse.json({ error: "invalid_item" }, { status: 400 });
  if (persist && request.nextUrl.searchParams.get("confirm") !== rawItemId) {
    return NextResponse.json({
      error: "persist_confirmation_required",
      message: "Para persistir, confirm deve ser igual ao MLB informado.",
    }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: account, error: accountError } = await admin.from("ml_accounts")
    .select("id,code,display_name,seller_id,connection_status")
    .eq("organization_id", access.organizationId).eq("code", accountCode).maybeSingle<AccountRow>();
  if (accountError || !account) return NextResponse.json({ error: "account_not_found" }, { status: 404 });
  if (account.connection_status !== "connected") {
    return NextResponse.json({ error: "account_not_connected", status: account.connection_status }, { status: 409 });
  }
  const { data: listing, error: listingError } = await admin.from("ml_listings")
    .select("id,product_id,item_id,title,seller_sku,currency_id,price,status")
    .eq("organization_id", access.organizationId).eq("ml_account_id", account.id)
    .eq("item_id", rawItemId).maybeSingle<ListingRow>();
  if (listingError || !listing) return NextResponse.json({ error: "listing_not_found_for_account" }, { status: 404 });

  try {
    const validToken = await getValidMercadoLivreAccessToken(account.id);
    const seller = await getMercadoLivreCurrentUser(validToken.accessToken);
    if (account.seller_id !== seller.id) return NextResponse.json({ error: "seller_mismatch" }, { status: 409 });
    const parsedLegacyPrice = listing.price === null ? null : Number(listing.price);
    const legacyListingPrice = parsedLegacyPrice !== null && Number.isFinite(parsedLegacyPrice) ? parsedLegacyPrice : null;
    const state = await resolveListingPriceState({ itemId: rawItemId, legacyListingPrice, accessToken: validToken.accessToken });
    const persisted = persist ? await persistListingPromotionState({
      listing: {
        id: listing.id, organizationId: access.organizationId, mlAccountId: account.id,
        productId: listing.product_id, itemId: listing.item_id,
        sellerSku: listing.seller_sku, currencyId: listing.currency_id,
      },
      state,
    }) : null;
    const accountResponse = {
      code: account.code, displayName: account.display_name,
      sellerId: account.seller_id, sellerNickname: seller.nickname,
    };
    const listingResponse = {
      itemId: listing.item_id, title: listing.title, sellerSku: listing.seller_sku,
      legacyPrice: listing.price, status: listing.status,
    };
    const compact = request.nextUrl.searchParams.get("compact") === "1";
    if (compact) {
      return NextResponse.json({
        ok: true, account: accountResponse, listing: listingResponse,
        standardPrice: state.standardPrice, basePriceDecision: state.basePriceDecision,
        normalizedSalePrice: state.normalizedSalePrice,
        normalizedPromotions: state.normalizedPromotions,
        winningOffer: state.winningOffer, winningOfferError: state.winningOfferError,
        resolved: state.resolved, activePromotionDetails: state.activePromotionDetails,
        promotionDetailsError: state.promotionDetailsError, persisted,
      });
    }
    return NextResponse.json({ ok: true, account: accountResponse, listing: listingResponse, ...state, persisted });
  } catch (error) {
    console.error("Mercado Livre promotions debug failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({
      error: "mercado_livre_promotions_debug_failed",
      message: error instanceof Error ? error.message : "Erro desconhecido.",
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handlePromotionsDebug(request, false);
}
export async function POST(request: NextRequest) {
  return handlePromotionsDebug(request, true);
}
