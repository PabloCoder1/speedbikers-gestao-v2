import "server-only";

import {
  NextResponse,
  type NextRequest,
} from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import {
  getMercadoLivreAppConfig,
  isMercadoLivreAppCode,
} from "@/integrations/mercado-livre/config";
import { MERCADO_LIVRE_URLS } from "@/integrations/mercado-livre/constants";
import {
  createOAuthState,
  createPkceChallenge,
  createPkceVerifier,
  hashOAuthState,
} from "@/integrations/mercado-livre/oauth";
import { encryptSecret } from "@/lib/security/encryption";
import { createAdminClient } from "@/lib/supabase/admin";

type MlAccountRow = {
  id: string;
  code: string;
  oauth_app_code: string;
  is_active: boolean;
  connection_status: string;
};

function redirectToAccounts(
  request: NextRequest,
  params: {
    error?: string;
  },
) {
  const url = new URL(
    "/contas",
    request.url,
  );

  if (params.error) {
    url.searchParams.set(
      "mlError",
      params.error,
    );
  }

  return NextResponse.redirect(url);
}

export async function GET(
  request: NextRequest,
) {
  const access =
    await getCurrentAccess();

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

  const accountCode =
    request.nextUrl.searchParams.get(
      "account",
    );

  if (!accountCode) {
    return redirectToAccounts(
      request,
      {
        error:
          "invalid_account",
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
        "oauth_app_code",
        "is_active",
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
    .maybeSingle<MlAccountRow>();

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

  if (!account.is_active) {
    return redirectToAccounts(
      request,
      {
        error:
          "account_disabled",
      },
    );
  }

  /*
   * IMPORTANTE:
   *
   * account.code identifica a conta
   * comercial dentro da V2.
   *
   * account.oauth_app_code identifica
   * a aplicação OAuth utilizada para
   * CLIENT_ID / CLIENT_SECRET.
   */
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

  const appConfig =
    getMercadoLivreAppConfig(
      account.oauth_app_code,
    );

  const state =
    createOAuthState();

  const pkceVerifier =
    createPkceVerifier();

  const pkceChallenge =
    createPkceChallenge(
      pkceVerifier,
    );

  const stateHash =
    hashOAuthState(state);

  const encryptedPkceVerifier =
    encryptSecret(
      pkceVerifier,
    );

  const expiresAt =
    new Date(
      Date.now() +
        10 * 60 * 1000,
    ).toISOString();

  const {
    error: oauthStateError,
  } = await admin
    .from("ml_oauth_states")
    .insert({
      organization_id:
        access.organizationId,

      ml_account_id:
        account.id,

      initiated_by:
        access.userId,

      state_hash:
        stateHash,

      pkce_verifier_encrypted:
        encryptedPkceVerifier,

      expires_at:
        expiresAt,
    });

  if (oauthStateError) {
    return redirectToAccounts(
      request,
      {
        error:
          "state_creation_failed",
      },
    );
  }

  const authorizationUrl =
    new URL(
      MERCADO_LIVRE_URLS.authorization,
    );

  authorizationUrl.searchParams.set(
    "response_type",
    "code",
  );

  authorizationUrl.searchParams.set(
    "client_id",
    appConfig.clientId,
  );

  authorizationUrl.searchParams.set(
    "redirect_uri",
    appConfig.redirectUri,
  );

  authorizationUrl.searchParams.set(
    "state",
    state,
  );

  authorizationUrl.searchParams.set(
    "code_challenge",
    pkceChallenge,
  );

  authorizationUrl.searchParams.set(
    "code_challenge_method",
    "S256",
  );

  authorizationUrl.searchParams.set(
    "scope",
    "offline_access read",
  );

  return NextResponse.redirect(
    authorizationUrl,
  );
}