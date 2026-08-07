import "server-only";

import { MERCADO_LIVRE_URLS } from "@/integrations/mercado-livre/constants";

export type MercadoLivreCurrentUser = {
  id: string;
  nickname: string;
  siteId: string;
};

type RawCurrentUser = {
  id?: unknown;
  nickname?: unknown;
  site_id?: unknown;
};

export async function getMercadoLivreCurrentUser(
  accessToken: string,
): Promise<MercadoLivreCurrentUser> {
  const response = await fetch(
    `${MERCADO_LIVRE_URLS.api}/users/me`,
    {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${accessToken}`,

        Accept:
          "application/json",
      },

      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(
      "Não foi possível identificar o seller autenticado.",
    );
  }

  const payload =
    (await response.json()) as
      RawCurrentUser;

  if (
    (
      typeof payload.id !==
        "number" &&
      typeof payload.id !==
        "string"
    ) ||
    typeof payload.nickname !==
      "string"
  ) {
    throw new Error(
      "Resposta de usuário do Mercado Livre inválida.",
    );
  }

  return {
    id: String(payload.id),

    nickname:
      payload.nickname,

    siteId:
      typeof payload.site_id ===
      "string"
        ? payload.site_id
        : "MLB",
  };
}