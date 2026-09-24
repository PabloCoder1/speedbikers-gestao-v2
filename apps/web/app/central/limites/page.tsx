import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoConteudo } from "../../../components/carregando";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { StatePill } from "../../../components/state-pill";
import { descreverLimites, LIMITES_PADRAO, lerLimites } from "../../../lib/limites-central";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import { AVISO } from "../../faturamento/numeros";
import { voltarAosPadroes } from "./actions";
import { FormularioLimites } from "./formulario";

export const metadata = { title: "Limites da central — Speed Bikers Gestão" };

// Sessão por cookie e RLS por quem está logado: nada aqui pode ser pré-renderizado.
export const dynamic = "force-dynamic";

/**
 * Limites da central (D-408) — os cortes que decidem quando um número da
 * central é estável, pede atenção ou é perigo. D-148: limiar é decisão do
 * dono, não constante do código.
 *
 * Leitura para todo membro; o formulário e "voltar aos padrões" só para ADMIN
 * e GESTOR — a regra de verdade mora nas policies de `central_thresholds`.
 */
export default function LimitesPage(): ReactNode {
  return (
    <Shell>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando os limites da central" />}>
        <LimitesContent />
      </Suspense>
    </Shell>
  );
}

function Titulo(): ReactNode {
  return (
    <PageTitle
      eyebrow="COMERCIAL / CENTRAL"
      title="Limites da central"
      subtitle="Quando um número da central é estável, pede atenção ou é perigo — e a partir de quantos pedidos uma comparação vale."
      aside={
        <Link className="sb-button" href="/central">
          Voltar à central
        </Link>
      }
    />
  );
}

async function LimitesContent(): Promise<ReactNode> {
  const supabase = await createClient();
  const membership = await currentMembership();
  const podeEditar = membership.role === "ADMIN" || membership.role === "GESTOR";

  const resposta =
    membership.organizationId === null
      ? null
      : await supabase
          .from("central_thresholds")
          .select(
            "change_neutral, change_strong, points_neutral, points_strong, goal_delay_warning, margin_after_ads_low, min_orders_sample, updated_at",
          )
          .eq("organization_id", membership.organizationId)
          .maybeSingle();

  // Tabela ausente (PGRST205 no PostgREST, 42P01 no Postgres) não é erro: a
  // web da `main` vai ao ar antes de a migration passar pelo workflow de
  // produção (o precedente de Metas e imposto).
  if (resposta?.error != null && (resposta.error.code === "PGRST205" || resposta.error.code === "42P01")) {
    return (
      <>
        <Titulo />
        <div className="sb-note">
          <span>SENDO ATIVADO</span>
          <p>
            Os limites estão sendo ativados neste ambiente: o banco ainda não recebeu a tabela de D-408. Enquanto isso, a
            central julga com os padrões.
          </p>
        </div>
      </>
    );
  }

  const limites = resposta?.error == null ? lerLimites(resposta?.data ?? null) : LIMITES_PADRAO;
  const descricoes = descreverLimites(limites);
  const alteradoEm = resposta?.data?.updated_at ?? null;

  return (
    <>
      <Titulo />

      {resposta?.error != null && (
        <p role="alert" style={AVISO}>
          Não foi possível carregar os limites: {resposta.error.message}. A central está julgando com os padrões.
        </p>
      )}

      {!podeEditar && (
        <div className="sb-note">
          <span>SÓ LEITURA</span>
          <p>Mudar os limites é de ADMIN e GESTOR.</p>
        </div>
      )}

      <Panel
        title="Limites"
        subtitle={
          limites.personalizados && alteradoEm !== null
            ? `Definidos pela empresa, alterados em ${new Date(alteradoEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`
            : "Os padrões do sistema: nenhum limite foi mudado ainda."
        }
        aside={
          <StatePill
            tone={limites.personalizados ? { tom: "info", label: "da empresa" } : { tom: "neutro", label: "padrão" }}
          />
        }
      >
        <div className="sb-panel-body">
          {podeEditar ? (
            <FormularioLimites limites={descricoes} />
          ) : (
            <dl className="sb-limites-lista">
              {descricoes.map((d) => (
                <div key={d.campo}>
                  <dt>{d.rotulo}</dt>
                  <dd>
                    <strong>{d.atual}</strong> <span className="sb-texto-suave">{d.dica}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {podeEditar && limites.personalizados && (
            <form action={voltarAosPadroes} className="sb-central-bloco">
              <button type="submit" className="sb-text-button">
                Voltar aos padrões
              </button>
            </form>
          )}

          <div className="sb-note sb-central-bloco">
            <span>ONDE CADA UM VALE</span>
            <p>
              As variações colorem os indicadores e o resumo da central; o atraso da meta, o ritmo do mês e o item de
              meta em "O que precisa da sua atenção"; a margem depois do Ads, a sugestão de escala em Sinais de Ads; a
              amostra mínima, a comparação de margem, frete e médias. Os limites dos sinais de Ads, do detector de frete e
              a margem de 10% do faturamento moram nas consultas do banco e ficam para uma próxima etapa.
            </p>
          </div>
        </div>
      </Panel>
    </>
  );
}
