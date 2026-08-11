import {
  NextResponse,
  type NextRequest,
} from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import {
  isMercadoLivreAppCode,
} from "@/integrations/mercado-livre/config";
import {
  hashOAuthState,
} from "@/integrations/mercado-livre/oauth";
import { exchangeAuthorizationCode } from "@/integrations/mercado-livre/token";
import { getMercadoLivreCurrentUser } from "@/integrations/mercado-livre/users";
import {
  decryptSecret,
  encryptSecret,
} from "@/lib/security/encryption";
import { createAdminClient } from "@/lib/supabase/admin";

type MlOAuthState = {
  organization_id: string;
  ml_account_id: string;
  pkce_verifier_encrypted: string;
};

type MlAccount = {
  id: string;
  code: string;

  oauth_app_code: string;

  expected_seller_id:
    | string
    | number
    | null;

  seller_id:
    | string
    | number
    | null;

  connection_status: string;
};

function redirectToAccounts(
  request: NextRequest,
  params: {
    connected?: string;
    error?: string;
  },
) {
  const url =
    new URL(
      "/contas",
      request.url,
    );

  if (params.connected) {
    url.searchParams.set(
      "mlConnected",
      params.connected,
    );
  }

  if (params.error) {
    url.searchParams.set(
      "mlError",
      params.error,
    );
  }

  return NextResponse.redirect(
    url,
  );
}

export async function GET(
  request: NextRequest,
) {
  const providerError =
    request.nextUrl.searchParams.get(
      "error",
    );

  if (providerError) {
    return redirectToAccounts(
      request,
      {
        error:
          "authorization_denied",
      },
    );
  }

  const code =
    request.nextUrl.searchParams.get(
      "code",
    );

  const state =
    request.nextUrl.searchParams.get(
      "state",
    );

  if (!code || !state) {
    return redirectToAccounts(
      request,
      {
        error:
          "missing_oauth_parameters",
      },
    );
  }

  const access =
    await getCurrentAccess();

  // O mesmo ADMIN que iniciou precisa concluir.
  if (
    !access ||
    access.role !== "admin"
  ) {
    return NextResponse.redirect(
      new URL(
        "/login",
        request.url,
      ),
    );
  }

  const admin =
    createAdminClient();

  const stateHash =
    hashOAuthState(state);

  const now =
    new Date().toISOString();

  // Consome o state atomicamente.
  // Uma segunda tentativa com o mesmo state não encontra linha.
  const {
    data: oauthState,
    error: oauthStateError,
  } = await admin
    .from("ml_oauth_states")
    .update({
      used_at: now,
    })
    .eq(
      "state_hash",
      stateHash,
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "initiated_by",
      access.userId,
    )
    .is(
      "used_at",
      null,
    )
    .gt(
      "expires_at",
      now,
    )
    .select(
      [
        "organization_id",
        "ml_account_id",
        "pkce_verifier_encrypted",
      ].join(","),
    )
    .maybeSingle<MlOAuthState>();

  if (
    oauthStateError ||
    !oauthState
  ) {
    return redirectToAccounts(
      request,
      {
        error:
          "invalid_oauth_state",
      },
    );
  }

  const {
    data: account,
    error: accountError,
  } = await admin
    .from("ml_accounts")
    .select(
  [
    "id",
    "code",
    "oauth_app_code",
    "expected_seller_id",
    "seller_id",
    "connection_status",
  ].join(","),
)
    .eq(
      "id",
      oauthState.ml_account_id,
    )
    .eq(
      "organization_id",
      oauthState.organization_id,
    )
    .maybeSingle<MlAccount>();

  if (
    accountError ||
    !account
  ) {
    return redirectToAccounts(
      request,
      {
        error:
          "account_not_found",
      },
    );
  }

  if (
  !isMercadoLivreAppCode(
    account.oauth_app_code,
  )
) {
  return redirectToAccounts(
    request,
    {
      error:
        "invalid_oauth_app_code",
    },
  );
}

  let codeVerifier: string;

  try {
    codeVerifier =
      decryptSecret(
        oauthState
          .pkce_verifier_encrypted,
      );
  } catch {
    return redirectToAccounts(
      request,
      {
        error:
          "pkce_decryption_failed",
      },
    );
  }

  let token;

  try {
    token =
  await exchangeAuthorizationCode({
    appCode:
      account.oauth_app_code,

    code,

    codeVerifier,
  });
  } catch (error) {
    console.error(
      "Mercado Livre token exchange failed:",
      error instanceof Error
        ? error.message
        : "unknown error",
    );

    return redirectToAccounts(
      request,
      {
        error:
          "token_exchange_failed",
      },
    );
  }

  let seller;

  try {
    seller =
      await getMercadoLivreCurrentUser(
        token.accessToken,
      );
  } catch (error) {
    console.error(
      "Mercado Livre seller lookup failed:",
      error instanceof Error
        ? error.message
        : "unknown error",
    );

    return redirectToAccounts(
      request,
      {
        error:
          "seller_lookup_failed",
      },
    );
  }

  const currentSellerId =
    account.seller_id === null
      ? null
      : String(
          account.seller_id,
        );

  const expectedSellerId =
    account.expected_seller_id === null
      ? null
      : String(
          account.expected_seller_id,
        );

  /*
   * Nunca permite que uma reconexão
   * troque o seller real da conta.
   */
  if (
    currentSellerId &&
    currentSellerId !==
      seller.id
  ) {
    return redirectToAccounts(
      request,
      {
        error:
          "seller_mismatch",
      },
    );
  }

  /*
   * Se já sabemos previamente qual
   * seller esta conta representa,
   * o OAuth também precisa retornar
   * exatamente esse seller.
   */
  if (
    expectedSellerId &&
    expectedSellerId !==
      seller.id
  ) {
    return redirectToAccounts(
      request,
      {
        error:
          "seller_mismatch",
      },
    );
  }

  const {
    data: duplicatedSellerAccount,
    error: duplicatedSellerError,
  } = await admin
    .from("ml_accounts")
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
      "seller_id",
      seller.id,
    )
    .neq(
      "id",
      account.id,
    )
    .limit(1)
    .maybeSingle();

  if (duplicatedSellerError) {
    return redirectToAccounts(
      request,
      {
        error:
          "seller_validation_failed",
      },
    );
  }

  if (duplicatedSellerAccount) {
    return redirectToAccounts(
      request,
      {
        error:
          "seller_already_connected",
      },
    );
  }

  const {
    data: existingCredentials,
    error:
      existingCredentialsError,
  } = await admin
    .from("ml_credentials")
    .select("token_version")
    .eq(
      "ml_account_id",
      account.id,
    )
    .maybeSingle();

  if (
    existingCredentialsError
  ) {
    return redirectToAccounts(
      request,
      {
        error:
          "credential_lookup_failed",
      },
    );
  }

  const tokenVersion =
    (
      existingCredentials
        ?.token_version ?? 0
    ) + 1;

  const expiresAt =
    new Date(
      Date.now() +
        token.expiresIn *
          1000,
    ).toISOString();

  // Primeiro registra a identidade do seller.
  // connection_status ainda não muda.
  const {
    error:
      sellerUpdateError,
  } = await admin
    .from("ml_accounts")
    .update({
      seller_id:
        seller.id,

      expected_seller_id:
        expectedSellerId ??
        seller.id,

      nickname:
        seller.nickname,

      site_id:
        seller.siteId,
    })
    .eq(
      "id",
      account.id,
    )
    .eq(
      "organization_id",
      access.organizationId,
    );

  if (sellerUpdateError) {
    return redirectToAccounts(
      request,
      {
        error:
          "seller_store_failed",
      },
    );
  }

  const {
    error:
      credentialStoreError,
  } = await admin
    .from("ml_credentials")
    .upsert(
      {
        organization_id:
          access.organizationId,

        ml_account_id:
          account.id,

        access_token_encrypted:
          encryptSecret(
            token.accessToken,
          ),

        refresh_token_encrypted:
          encryptSecret(
            token.refreshToken,
          ),

        token_type:
          token.tokenType,

        scope:
          token.scope,

        expires_at:
          expiresAt,

        token_version:
          tokenVersion,

        refresh_lock_id:
          null,

        refresh_lock_expires_at:
          null,
      },
      {
        onConflict:
          "ml_account_id",
      },
    );

  if (credentialStoreError) {
    console.error(
      "Mercado Livre credential store failed.",
    );

    return redirectToAccounts(
      request,
      {
        error:
          "credential_store_failed",
      },
    );
  }

  const {
    error:
      connectionUpdateError,
  } = await admin
    .from("ml_accounts")
    .update({
      connection_status:
        "connected",

      connected_at:
        new Date()
          .toISOString(),
    })
    .eq(
      "id",
      account.id,
    )
    .eq(
      "organization_id",
      access.organizationId,
    );

  if (connectionUpdateError) {
    return redirectToAccounts(
      request,
      {
        error:
          "connection_update_failed",
      },
    );
  }

  return redirectToAccounts(
    request,
    {
      connected:
        account.code,
    },
  );
}