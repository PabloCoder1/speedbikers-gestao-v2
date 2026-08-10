import "server-only";

import {
  randomUUID,
} from "node:crypto";

import {
  isMercadoLivreAppCode,
} from "./config";
import {
  MercadoLivreTokenRequestError,
  refreshAccessToken,
} from "./token";
import {
  decryptSecret,
  encryptSecret,
} from "../../lib/security/encryption";
import { createAdminClient } from "../../lib/supabase/admin";

const REFRESH_SAFETY_WINDOW_MS =
  30 * 60 * 1000;

const REFRESH_LOCK_SECONDS =
  60;

const LOCK_WAIT_ATTEMPTS =
  10;

const LOCK_WAIT_MS =
  500;

type MlAccountRow = {
  id: string;
  organization_id: string;
  code: string;
  seller_id: string | null;
  connection_status: string;
};

type MlCredentialRow = {
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  expires_at: string;
  token_version: number;
};

export type ValidMercadoLivreToken = {
  accessToken: string;
  expiresAt: string;
  refreshed: boolean;
};

function tokenStillUsable(
  expiresAt: string,
) {
  const expiresAtTime =
    Date.parse(expiresAt);

  if (
    Number.isNaN(
      expiresAtTime,
    )
  ) {
    return false;
  }

  return (
    expiresAtTime -
      Date.now() >
    REFRESH_SAFETY_WINDOW_MS
  );
}

function sleep(
  milliseconds: number,
) {
  return new Promise<void>(
    (resolve) => {
      setTimeout(
        resolve,
        milliseconds,
      );
    },
  );
}

async function loadCredentials(
  mlAccountId: string,
): Promise<MlCredentialRow> {
  const admin =
    createAdminClient();

  const {
    data,
    error,
  } = await admin
    .from("ml_credentials")
    .select(
      [
        "access_token_encrypted",
        "refresh_token_encrypted",
        "expires_at",
        "token_version",
      ].join(","),
    )
    .eq(
      "ml_account_id",
      mlAccountId,
    )
    .maybeSingle<MlCredentialRow>();

  if (error || !data) {
    throw new Error(
      "Credenciais Mercado Livre não encontradas.",
    );
  }

  return data;
}

async function waitForConcurrentRefresh(
  mlAccountId: string,
  previousVersion: number,
): Promise<ValidMercadoLivreToken> {
  for (
    let attempt = 0;
    attempt <
    LOCK_WAIT_ATTEMPTS;
    attempt += 1
  ) {
    await sleep(
      LOCK_WAIT_MS,
    );

    const credentials =
      await loadCredentials(
        mlAccountId,
      );

    if (
      credentials.token_version >
        previousVersion &&
      tokenStillUsable(
        credentials.expires_at,
      )
    ) {
      return {
        accessToken:
          decryptSecret(
            credentials
              .access_token_encrypted,
          ),

        expiresAt:
          credentials.expires_at,

        refreshed: true,
      };
    }
  }

  throw new Error(
    "Outra renovação de token ainda está em andamento.",
  );
}

export async function getValidMercadoLivreAccessToken(
  mlAccountId: string,
): Promise<ValidMercadoLivreToken> {
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
        "organization_id",
        "code",
        "seller_id",
        "connection_status",
      ].join(","),
    )
    .eq(
      "id",
      mlAccountId,
    )
    .maybeSingle<MlAccountRow>();

  if (
    accountError ||
    !account
  ) {
    throw new Error(
      "Conta Mercado Livre não encontrada.",
    );
  }

  const typedAccount =
    account as MlAccountRow;

  if (
    typedAccount
      .connection_status !==
    "connected"
  ) {
    throw new Error(
      "Conta Mercado Livre não está conectada.",
    );
  }

  if (
    !typedAccount.seller_id
  ) {
    throw new Error(
      "Seller Mercado Livre não identificado.",
    );
  }

  if (
    !isMercadoLivreAppCode(
      typedAccount.code,
    )
  ) {
    throw new Error(
      "Aplicação Mercado Livre não configurada.",
    );
  }

  const credentials =
    await loadCredentials(
      typedAccount.id,
    );

  // Ainda há bastante validade.
  // Não gastamos o refresh token.
  if (
    tokenStillUsable(
      credentials.expires_at,
    )
  ) {
    return {
      accessToken:
        decryptSecret(
          credentials
            .access_token_encrypted,
        ),

      expiresAt:
        credentials.expires_at,

      refreshed: false,
    };
  }

  const lockId =
    randomUUID();

  const {
    data: lockAcquired,
    error: lockError,
  } = await admin.rpc(
    "acquire_ml_refresh_lock",
    {
      target_ml_account_id:
        typedAccount.id,

      requested_lock_id:
        lockId,

      lock_duration_seconds:
        REFRESH_LOCK_SECONDS,
    },
  );

  if (lockError) {
    throw new Error(
      "Não foi possível adquirir o lock de renovação.",
    );
  }

  // Outro processo já está fazendo
  // o refresh desta mesma conta.
  if (!lockAcquired) {
    return waitForConcurrentRefresh(
      typedAccount.id,
      credentials.token_version,
    );
  }

  try {
    const refreshToken =
      decryptSecret(
        credentials
          .refresh_token_encrypted,
      );

    const newToken =
      await refreshAccessToken({
        appCode:
          typedAccount.code,

        refreshToken,
      });

    // Proteção extra: o refresh deve
    // continuar pertencendo ao mesmo seller.
    if (
      newToken.userId &&
      newToken.userId !==
        typedAccount.seller_id
    ) {
      throw new Error(
        "O token renovado pertence a outro seller.",
      );
    }

    const now =
      new Date();

    const expiresAt =
      new Date(
        now.getTime() +
          newToken.expiresIn *
            1000,
      ).toISOString();

    const {
      data: updatedCredentials,
      error: updateError,
    } = await admin
      .from("ml_credentials")
      .update({
        access_token_encrypted:
          encryptSecret(
            newToken.accessToken,
          ),

        refresh_token_encrypted:
          encryptSecret(
            newToken.refreshToken,
          ),

        token_type:
          newToken.tokenType,

        scope:
          newToken.scope,

        expires_at:
          expiresAt,

        token_version:
          credentials
            .token_version + 1,

        last_refreshed_at:
          now.toISOString(),

        refresh_lock_id:
          null,

        refresh_lock_expires_at:
          null,
      })
      .eq(
        "ml_account_id",
        typedAccount.id,
      )
      .eq(
        "refresh_lock_id",
        lockId,
      )
      .eq(
        "token_version",
        credentials
          .token_version,
      )
      .select(
        "token_version",
      )
      .maybeSingle();

    if (
      updateError ||
      !updatedCredentials
    ) {
      throw new Error(
        "Não foi possível salvar o token renovado.",
      );
    }

    return {
      accessToken:
        newToken.accessToken,

      expiresAt,

      refreshed: true,
    };
  } catch (error) {
    // invalid_grant normalmente significa
    // refresh token expirado, usado,
    // revogado ou grant removido.
    if (
      error instanceof
        MercadoLivreTokenRequestError &&
      error.code ===
        "invalid_grant"
    ) {
      await admin
        .from("ml_accounts")
        .update({
          connection_status:
            "reauthorization_required",
        })
        .eq(
          "id",
          typedAccount.id,
        );
    }

    throw error;
  } finally {
    // Se o UPDATE de sucesso já limpou
    // o lock, esta chamada apenas retorna
    // false. Isso é intencional.
    await admin.rpc(
      "release_ml_refresh_lock",
      {
        target_ml_account_id:
          typedAccount.id,

        requested_lock_id:
          lockId,
      },
    );
  }
}