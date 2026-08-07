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

function redirectToAccounts(
  request: NextRequest,
  error: string,
) {
  const url =
    new URL(
      "/contas",
      request.url,
    );

  url.searchParams.set(
    "mlError",
    error,
  );

  return NextResponse.redirect(
    url,
  );
}

export async function GET(
  request: NextRequest,
) {
  const access =
    await getCurrentAccess();

  if (!access) {
    return NextResponse.redirect(
      new URL(
        "/login",
        request.url,
      ),
    );
  }

  // OAuth Mercado Livre é exclusivo do ADMIN.
  if (access.role !== "admin") {
    return NextResponse.redirect(
      new URL("/", request.url),
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
    return redirectToAccounts(
      request,
      "invalid_account",
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
      "id, code, is_active",
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "code",
      accountCode,
    )
    .maybeSingle();

  if (
    accountError ||
    !account
  ) {
    return redirectToAccounts(
      request,
      "account_not_found",
    );
  }

  if (!account.is_active) {
    return redirectToAccounts(
      request,
      "account_disabled",
    );
  }

  const state =
    createOAuthState();

  const stateHash =
    hashOAuthState(state);

  const codeVerifier =
    createPkceVerifier();

  const codeChallenge =
    createPkceChallenge(
      codeVerifier,
    );

  const expiresAt =
    new Date(
      Date.now() +
        10 * 60 * 1000,
    ).toISOString();

  // Uma nova tentativa invalida states anteriores ainda
  // pendentes para a mesma conta/admin.
  await admin
    .from("ml_oauth_states")
    .delete()
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "ml_account_id",
      account.id,
    )
    .eq(
      "initiated_by",
      access.userId,
    )
    .is(
      "used_at",
      null,
    );

  const {
    error: stateError,
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
        encryptSecret(
          codeVerifier,
        ),

      expires_at:
        expiresAt,
    });

  if (stateError) {
    return redirectToAccounts(
      request,
      "state_creation_failed",
    );
  }

  const config =
    getMercadoLivreAppConfig(
      accountCode,
    );

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
    config.clientId,
  );

  authorizationUrl.searchParams.set(
    "redirect_uri",
    config.redirectUri,
  );

  authorizationUrl.searchParams.set(
    "state",
    state,
  );

  authorizationUrl.searchParams.set(
    "code_challenge",
    codeChallenge,
  );

  authorizationUrl.searchParams.set(
    "code_challenge_method",
    "S256",
  );

  return NextResponse.redirect(
    authorizationUrl,
  );
}