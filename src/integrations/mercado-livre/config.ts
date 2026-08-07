import "server-only";

export type MercadoLivreAppCode =
  | "speedbikers"
  | "offracer"
  | "sb"
  | "gmr";

type MercadoLivreAppConfig = {
  clientId: string;
  clientSecret: string;
};

export type MercadoLivreConfig = {
  redirectUri: string;
  apps: Record<
    MercadoLivreAppCode,
    MercadoLivreAppConfig
  >;
};

function requireEnvironmentVariable(
  name: string,
): string {
  const value =
    process.env[name];

  if (!value) {
    throw new Error(
      `${name} não está configurada.`,
    );
  }

  return value;
}

export function getMercadoLivreConfig(): MercadoLivreConfig {
  const redirectUri =
    requireEnvironmentVariable(
      "MERCADO_LIVRE_REDIRECT_URI",
    );

  let parsedRedirectUri: URL;

  try {
    parsedRedirectUri =
      new URL(redirectUri);
  } catch {
    throw new Error(
      "MERCADO_LIVRE_REDIRECT_URI possui uma URL inválida.",
    );
  }

  if (
    parsedRedirectUri.protocol !==
    "https:"
  ) {
    throw new Error(
      "MERCADO_LIVRE_REDIRECT_URI deve utilizar HTTPS.",
    );
  }

  return {
    redirectUri,

    apps: {
      speedbikers: {
        clientId:
          requireEnvironmentVariable(
            "MERCADO_LIVRE_SPEEDBIKERS_CLIENT_ID",
          ),

        clientSecret:
          requireEnvironmentVariable(
            "MERCADO_LIVRE_SPEEDBIKERS_CLIENT_SECRET",
          ),
      },

      offracer: {
        clientId:
          requireEnvironmentVariable(
            "MERCADO_LIVRE_OFFRACER_CLIENT_ID",
          ),

        clientSecret:
          requireEnvironmentVariable(
            "MERCADO_LIVRE_OFFRACER_CLIENT_SECRET",
          ),
      },

      sb: {
        clientId:
          requireEnvironmentVariable(
            "MERCADO_LIVRE_SB_CLIENT_ID",
          ),

        clientSecret:
          requireEnvironmentVariable(
            "MERCADO_LIVRE_SB_CLIENT_SECRET",
          ),
      },

      gmr: {
        clientId:
          requireEnvironmentVariable(
            "MERCADO_LIVRE_GMR_CLIENT_ID",
          ),

        clientSecret:
          requireEnvironmentVariable(
            "MERCADO_LIVRE_GMR_CLIENT_SECRET",
          ),
      },
    },
  };
}

export function getMercadoLivreAppConfig(
  code: MercadoLivreAppCode,
) {
  const config =
    getMercadoLivreConfig();

  return {
    ...config.apps[code],
    redirectUri:
      config.redirectUri,
  };
}

export function isMercadoLivreAppCode(
  value: string,
): value is MercadoLivreAppCode {
  return (
    value === "speedbikers" ||
    value === "offracer" ||
    value === "sb" ||
    value === "gmr"
  );
}