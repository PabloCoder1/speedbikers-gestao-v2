import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentAccess } from "@/features/auth/get-current-access";

export default async function DashboardPage() {
  const access =
    await getCurrentAccess();

  if (!access) {
    return null;
  }

  return (
    <div className="px-6 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <PageHeader
          eyebrow={access.organizationName}
          title="Visão Geral"
          description="Esta será a visão consolidada da operação do Speed Bikers Gestão V2."
        />

        <section className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Autenticação"
            value="Ativa"
            description="Sessão protegida pelo Supabase."
            badge={
              <Badge variant="success">
                Online
              </Badge>
            }
          />

          <MetricCard
            label="Organização"
            value={
              access.organizationName
            }
            description="Contexto organizacional ativo."
          />

          <MetricCard
            label="Papel"
            value={
              <span className="uppercase">
                {access.role}
              </span>
            }
            description="Permissão atual do usuário."
          />

          <MetricCard
            label="Infraestrutura"
            value="Online"
            description="Fundação pronta para os módulos."
            badge={
              <Badge variant="success">
                OK
              </Badge>
            }
          />
        </section>

        <section className="mt-6">
          <Card>
            <CardContent className="p-7">
              <Badge variant="success">
                Fundação concluída
              </Badge>

              <h2 className="mt-5 text-xl font-semibold tracking-tight text-gray-950">
                O design system básico da V2
                está ativo.
              </h2>

              <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-600">
                A partir de agora os
                módulos utilizarão
                componentes visuais
                reutilizáveis para manter
                consistência de interface,
                comportamento e
                manutenção.
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}