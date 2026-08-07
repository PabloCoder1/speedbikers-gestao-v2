import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getOrganizationUsers } from "@/features/admin/get-organization-users";
import { ROLE_LABELS } from "@/features/auth/roles";

export const metadata: Metadata = {
  title: "Administração",
};

const dateFormatter =
  new Intl.DateTimeFormat(
    "pt-BR",
    {
      dateStyle: "short",
      timeStyle: "short",
    },
  );

function formatDate(
  value: string | null,
) {
  if (!value) {
    return "Nunca";
  }

  const date = new Date(value);

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return "—";
  }

  return dateFormatter.format(date);
}

export default async function AdministrationPage() {
  const { access, users } =
    await getOrganizationUsers();

  return (
    <div className="px-6 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <PageHeader
          eyebrow={
            access.organizationName
          }
          title="Administração"
          description="Gerencie usuários internos, papéis e permissões de acesso ao Speed Bikers Gestão."
        />

        <section className="mt-8">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold text-gray-950">
                    Usuários internos
                  </h2>

                  <p className="mt-1 text-sm text-gray-500">
                    {
                      users.length
                    }{" "}
                    usuário
                    {users.length === 1
                      ? ""
                      : "s"}{" "}
                    vinculado
                    {users.length === 1
                      ? ""
                      : "s"}{" "}
                    à organização.
                  </p>
                </div>

                <Badge variant="info">
                  Somente leitura
                </Badge>
              </div>
            </CardHeader>

            <CardContent className="p-0">
              {users.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-sm font-medium text-gray-900">
                    Nenhum usuário
                    encontrado.
                  </p>

                  <p className="mt-2 text-sm text-gray-500">
                    Ainda não existem
                    membros vinculados a
                    esta organização.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Usuário
                        </th>

                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Papel
                        </th>

                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Status
                        </th>

                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Último acesso
                        </th>

                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Vínculo criado
                        </th>
                      </tr>
                    </thead>

                    <tbody className="divide-y divide-gray-100 bg-white">
                      {users.map(
                        (user) => {
                          let statusBadge;

                          if (
                            !user.isActive
                          ) {
                            statusBadge = (
                              <Badge variant="danger">
                                Inativo
                              </Badge>
                            );
                          } else if (
                            user.mustChangePassword
                          ) {
                            statusBadge = (
                              <Badge variant="warning">
                                Primeiro acesso
                              </Badge>
                            );
                          } else if (
                            !user.emailConfirmedAt
                          ) {
                            statusBadge = (
                              <Badge variant="warning">
                                E-mail pendente
                              </Badge>
                            );
                          } else {
                            statusBadge = (
                              <Badge variant="success">
                                Ativo
                              </Badge>
                            );
                          }

                          return (
                            <tr
                              key={
                                user.userId
                              }
                              className="hover:bg-gray-50/70"
                            >
                              <td className="whitespace-nowrap px-6 py-4">
                                <p className="text-sm font-medium text-gray-950">
                                  {user.fullName ||
                                    "Sem nome"}
                                </p>

                                <p className="mt-1 text-xs text-gray-500">
                                  {user.email ||
                                    "E-mail indisponível"}
                                </p>
                              </td>

                              <td className="whitespace-nowrap px-6 py-4">
                                <Badge variant="neutral">
                                  {
                                    ROLE_LABELS[
                                      user
                                        .role
                                    ]
                                  }
                                </Badge>
                              </td>

                              <td className="whitespace-nowrap px-6 py-4">
                                {
                                  statusBadge
                                }
                              </td>

                              <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                                {formatDate(
                                  user.lastSignInAt,
                                )}
                              </td>

                              <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                                {formatDate(
                                  user.createdAt,
                                )}
                              </td>
                            </tr>
                          );
                        },
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <section className="mt-6">
          <Card>
            <CardContent>
              <Badge variant="neutral">
                Próxima evolução
              </Badge>

              <h2 className="mt-4 text-base font-semibold text-gray-950">
                Gerenciamento de
                usuários
              </h2>

              <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
                A listagem já utiliza
                dados reais. Criação,
                convite, alteração de
                papel e ativação ou
                bloqueio serão
                adicionados depois que
                esta camada de leitura e
                autorização estiver
                validada.
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}