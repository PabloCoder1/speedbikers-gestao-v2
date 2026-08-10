import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  getMlAccounts,
  type MlAccountConnectionStatus,
} from "@/features/ml-accounts/get-ml-accounts";
import { getListingsSyncProgress } from "@/features/ml-sync/get-listings-sync-progress";
import { FullListingSyncForm } from "@/components/ml-accounts/full-listing-sync-form";
import { OrdersSyncForm } from "@/features/ml-accounts/orders-sync-form";
import { ListingsSyncProgress } from "@/components/ml-accounts/listings-sync-progress";

export const metadata: Metadata = {
  title: "Contas",
};

type AccountStatusPresentation = {
  label: string;
  variant:
  | "neutral"
  | "success"
  | "warning"
  | "danger";
};

const statusPresentation: Record<
  MlAccountConnectionStatus,
  AccountStatusPresentation
> = {
  not_connected: {
    label: "Não conectada",
    variant: "neutral",
  },

  connected: {
    label: "Conectada",
    variant: "success",
  },

  reauthorization_required: {
    label: "Reconectar",
    variant: "warning",
  },

  disabled: {
    label: "Desativada",
    variant: "danger",
  },
};

type AccountsPageProps = {
  searchParams: Promise<{
    mlConnected?: string;
    mlError?: string;
  }>;
};

const oauthErrorMessages: Record<string, string> = {
  invalid_account:
    "A conta selecionada é inválida.",

  account_not_found:
    "A conta não foi encontrada.",

  account_disabled:
    "Esta conta está desativada.",

  state_creation_failed:
    "Não foi possível iniciar a autorização.",

  authorization_denied:
    "A autorização do Mercado Livre foi cancelada.",

  missing_oauth_parameters:
    "O Mercado Livre não retornou os parâmetros esperados.",

  invalid_oauth_state:
    "A tentativa de autorização expirou ou já foi utilizada.",

  invalid_account_code:
    "A configuração da aplicação Mercado Livre é inválida.",

  pkce_decryption_failed:
    "Não foi possível validar a autorização PKCE.",

  token_exchange_failed:
    "Não foi possível obter os tokens do Mercado Livre.",

  seller_lookup_failed:
    "O token foi obtido, mas não foi possível identificar o seller.",

  seller_mismatch:
    "A conta Mercado Livre autorizada é diferente do seller já vinculado.",

  credential_lookup_failed:
    "Não foi possível verificar as credenciais existentes.",

  seller_store_failed:
    "Não foi possível registrar o seller.",

  credential_store_failed:
    "Não foi possível armazenar as credenciais com segurança.",

  connection_update_failed:
    "As credenciais foram recebidas, mas o status da conexão não pôde ser atualizado.",
};

export default async function AccountsPage({
  searchParams,
}: AccountsPageProps) {
  const params =
    await searchParams;
  const {
    access,
    accounts,
  } = await getMlAccounts();

  const listingsSyncByAccount =
    await getListingsSyncProgress(
      accounts.map(
        (account) =>
          account.id,
      ),
    );

  if (!access) {
    return null;
  }

  return (
    <div className="px-6 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <PageHeader
          eyebrow={
            access.organizationName
          }
          title="Contas Mercado Livre"
          description="Gerencie as contas Mercado Livre disponíveis para sua organização e acompanhe o estado de cada conexão."
        />

        {params.mlConnected ? (
          <div className="mt-6 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            Conta Mercado Livre conectada com sucesso.
          </div>
        ) : null}

        {params.mlError ? (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {oauthErrorMessages[
              params.mlError
            ] ??
              "Não foi possível concluir a conexão com o Mercado Livre."}
          </div>
        ) : null}

        {accounts.length === 0 ? (
          <section className="mt-8">
            <Card>
              <CardContent className="p-8">
                <h2 className="text-base font-semibold text-gray-950">
                  Nenhuma conta disponível
                </h2>

                <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">
                  Seu usuário ainda não
                  possui permissão para
                  visualizar contas do
                  Mercado Livre.
                </p>
              </CardContent>
            </Card>
          </section>
        ) : (
          <section className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {accounts.map(
              (account) => {
                const status =
                  statusPresentation[
                  account
                    .connectionStatus
                  ];

                const listingsSync =
                  listingsSyncByAccount[
                    account.id
                  ] ?? null;

                const listingsSyncActive =
                  listingsSync?.status ===
                    "queued" ||
                  listingsSync?.status ===
                    "running";

                return (
                  <Card
                    key={account.id}
                  >
                    <CardContent>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                            Mercado Livre
                          </p>

                          <h2 className="mt-2 text-lg font-semibold text-gray-950">
                            {
                              account
                                .displayName
                            }
                          </h2>
                        </div>

                        <Badge
                          variant={
                            status.variant
                          }
                        >
                          {
                            status.label
                          }
                        </Badge>
                      </div>

                      <dl className="mt-6 space-y-4">
                        <div>
                          <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                            Seller ID
                          </dt>

                          <dd className="mt-1 text-sm font-medium text-gray-800">
                            {account.sellerId ??
                              "Aguardando conexão"}
                          </dd>
                        </div>

                        <div>
                          <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                            Nickname
                          </dt>

                          <dd className="mt-1 text-sm font-medium text-gray-800">
                            {account.nickname ??
                              "Aguardando conexão"}
                          </dd>
                        </div>

                        <div>
                          <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                            Site
                          </dt>

                          <dd className="mt-1 text-sm font-medium text-gray-800">
                            {
                              account.siteId
                            }
                          </dd>
                        </div>

                        <div>
                          <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                            Última sincronização
                          </dt>

                          <dd className="mt-1 text-sm font-medium text-gray-800">
                            {account.lastSyncedAt
                              ? new Intl.DateTimeFormat(
                                "pt-BR",
                                {
                                  dateStyle:
                                    "short",

                                  timeStyle:
                                    "short",

                                  timeZone:
                                    "America/Sao_Paulo",
                                },
                              ).format(
                                new Date(
                                  account.lastSyncedAt,
                                ),
                              )
                              : "Nunca"}
                          </dd>
                        </div>
                      </dl>

                      {access.role === "admin" &&
                        account.isActive ? (
                        <div className="mt-6 border-t border-gray-100 pt-5">
                          <a
                            href={`/api/mercado-livre/connect?account=${encodeURIComponent(
                              account.code,
                            )}`}
                            className="inline-flex w-full items-center justify-center rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800"
                          >
                            {account.connectionStatus ===
                              "connected"
                              ? "Reconectar"
                              : "Conectar"}
                          </a>

                          {access.role === "admin" &&
                            account.code === "sb" &&
                            account.connectionStatus ===
                            "connected" ? (
                            <>
                              {listingsSync ? (
                                <ListingsSyncProgress
                                  progress={
                                    listingsSync
                                  }
                                />
                              ) : null}

                              {!listingsSyncActive ? (
                                <FullListingSyncForm
                                  mlAccountId={
                                    account.id
                                  }
                                />
                              ) : null}

                              {listingsSync?.status ===
                              "succeeded" ? (
                                <OrdersSyncForm
                                  mlAccountId={
                                    account.id
                                  }
                                />
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              },
            )}
          </section>
        )}
      </div>
    </div>
  );
}