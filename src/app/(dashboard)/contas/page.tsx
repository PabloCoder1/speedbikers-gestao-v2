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

export default async function AccountsPage() {
  const {
    access,
    accounts,
  } = await getMlAccounts();

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
                      </dl>
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