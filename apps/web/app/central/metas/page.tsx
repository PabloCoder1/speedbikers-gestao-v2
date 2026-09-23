import { shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoConteudo } from "../../../components/carregando";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { StatePill } from "../../../components/state-pill";
import { formatBusinessDate, formatCurrency } from "../../../lib/format";
import { formatarAliquota, rotuloDoMes } from "../../../lib/metas-imposto";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import { AVISO } from "../../faturamento/numeros";
import { remover } from "./actions";
import { FormularioAliquota, FormularioMeta } from "./formularios";

export const metadata = { title: "Metas e imposto — Speed Bikers Gestão" };

// Sessão por cookie e RLS por quem está logado: nada aqui pode ser pré-renderizado.
export const dynamic = "force-dynamic";

/**
 * Metas e imposto (D-395) — o que a Central do negócio precisa que alguém
 * diga: a meta de faturamento de cada mês e a alíquota efetiva de imposto,
 * com vigência.
 *
 * Leitura para todo membro; formulários e "remover" só para ADMIN e GESTOR —
 * e a regra de verdade mora nas policies, não aqui: esconder o formulário é
 * conforto, a RLS é a autorização.
 */
export default function MetasPage(): ReactNode {
  return (
    <Shell>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando metas e imposto" />}>
        <MetasContent />
      </Suspense>
    </Shell>
  );
}

function BotaoRemover({ tabela, id, rotulo }: { tabela: "monthly_goals" | "tax_rates"; id: string; rotulo: string }): ReactNode {
  return (
    <form action={remover}>
      <input type="hidden" name="tabela" value={tabela} />
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="sb-text-button" aria-label={rotulo}>
        remover
      </button>
    </form>
  );
}

async function MetasContent(): Promise<ReactNode> {
  const supabase = await createClient();
  const membership = await currentMembership();
  const podeEditar = membership.role === "ADMIN" || membership.role === "GESTOR";
  const hoje = toSalesMetricDate(new Date());
  const mesAtual = `${hoje.slice(0, 8)}01`;

  const [metas, aliquotas] = await Promise.all([
    supabase.from("monthly_goals").select("id, month, revenue_goal, note").order("month", { ascending: false }).limit(24),
    supabase.from("tax_rates").select("id, valid_from, rate, note").order("valid_from", { ascending: false }).limit(50),
  ]);

  // Tabela ausente (PGRST205 no PostgREST, 42P01 no Postgres) não é erro: a
  // web da `main` vai ao ar antes de a migration passar pelo workflow de
  // produção — o precedente de D-363 para função ausente.
  const ausente = [metas.error, aliquotas.error].some((e) => e !== null && (e.code === "PGRST205" || e.code === "42P01"));

  // A vigência que vale hoje: a de início mais recente que não está no futuro.
  const vigente = (aliquotas.data ?? []).find((a) => a.valid_from <= hoje) ?? null;

  if (ausente) {
    return (
      <>
        <PageTitle
          eyebrow="COMERCIAL / CENTRAL"
          title="Metas e imposto"
          subtitle="A meta de faturamento de cada mês e a alíquota de imposto que a Central do negócio usa."
          aside={
            <Link className="sb-button" href="/central">
              Voltar à central
            </Link>
          }
        />
        <div className="sb-note">
          <span>SENDO ATIVADO</span>
          <p>
            Metas e imposto estão sendo ativados neste ambiente: o banco ainda não recebeu as tabelas de D-395. Assim
            que a migração for aplicada, esta tela passa a aceitar a meta do mês e a alíquota.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageTitle
        eyebrow="COMERCIAL / CENTRAL"
        title="Metas e imposto"
        subtitle="A meta de faturamento de cada mês e a alíquota de imposto que a Central do negócio usa."
        aside={
          <Link className="sb-button" href="/central">
            Voltar à central
          </Link>
        }
      />

      {!podeEditar && (
        <div className="sb-note">
          <span>SÓ LEITURA</span>
          <p>Cadastrar e remover meta e alíquota é de ADMIN e GESTOR.</p>
        </div>
      )}

      <div className="sb-pair-grid">
        <Panel
          title="Meta de faturamento"
          subtitle="Uma por mês, da empresa inteira. Cadastrar de novo o mesmo mês corrige a meta."
        >
          <div className="sb-panel-body">
            {podeEditar && <FormularioMeta mesPadrao={mesAtual.slice(0, 7)} />}

            {metas.error !== null ? (
              <p role="alert" style={AVISO}>
                Não foi possível carregar as metas: {metas.error.message}
              </p>
            ) : metas.data.length === 0 ? (
              <p className="sb-empty">Nenhuma meta cadastrada. Sem meta, a central mostra a projeção do mês sozinha.</p>
            ) : (
              <table className="sb-table sb-cadastro-tabela">
                <thead>
                  <tr>
                    <th>Mês</th>
                    <th className="sb-num">Meta</th>
                    <th>Nota</th>
                    {podeEditar && <th aria-label="Ações" />}
                  </tr>
                </thead>
                <tbody>
                  {metas.data.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {rotuloDoMes(m.month)} {m.month === mesAtual && <StatePill tone={{ tom: "info", label: "mês atual" }} />}
                      </td>
                      <td className="sb-num">{formatCurrency(m.revenue_goal)}</td>
                      <td className="sb-texto-suave">{m.note ?? "—"}</td>
                      {podeEditar && (
                        <td>
                          <BotaoRemover tabela="monthly_goals" id={m.id} rotulo={`Remover a meta de ${rotuloDoMes(m.month)}`} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>

        <Panel
          title="Alíquota de imposto"
          subtitle={
            vigente === null
              ? "Nenhuma alíquota vale hoje: o imposto e o lucro após imposto ficam em branco na central."
              : `Hoje vale ${formatarAliquota(vigente.rate)} sobre o faturamento, desde ${formatBusinessDate(vigente.valid_from)}.`
          }
        >
          <div className="sb-panel-body">
            {podeEditar && <FormularioAliquota dataPadrao={`${hoje.slice(0, 4)}-01-01`} />}

            {aliquotas.error !== null ? (
              <p role="alert" style={AVISO}>
                Não foi possível carregar as alíquotas: {aliquotas.error.message}
              </p>
            ) : aliquotas.data.length === 0 ? (
              <p className="sb-empty">Nenhuma alíquota cadastrada.</p>
            ) : (
              <table className="sb-table sb-cadastro-tabela">
                <thead>
                  <tr>
                    <th>Vigência</th>
                    <th className="sb-num">Alíquota</th>
                    <th>Nota</th>
                    {podeEditar && <th aria-label="Ações" />}
                  </tr>
                </thead>
                <tbody>
                  {aliquotas.data.map((a, indice) => {
                    // A lista vem da mais nova para a mais antiga: a vigência
                    // termina na véspera da linha ACIMA desta.
                    const proxima = indice === 0 ? null : (aliquotas.data[indice - 1]?.valid_from ?? null);

                    return (
                      <tr key={a.id}>
                        <td>
                          {formatBusinessDate(a.valid_from)}
                          {proxima === null ? " em diante" : ` a ${formatBusinessDate(shiftBusinessDate(proxima, -1))}`}{" "}
                          {vigente?.id === a.id && <StatePill tone={{ tom: "ok", label: "vale hoje" }} />}
                        </td>
                        <td className="sb-num">{formatarAliquota(a.rate)}</td>
                        <td className="sb-texto-suave">{a.note ?? "—"}</td>
                        {podeEditar && (
                          <td>
                            <BotaoRemover
                              tabela="tax_rates"
                              id={a.id}
                              rotulo={`Remover a alíquota de ${formatBusinessDate(a.valid_from)}`}
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <div className="sb-note sb-central-bloco">
              <span>COMO O IMPOSTO ENTRA</span>
              <p>
                Cada pedido paga a alíquota vigente no dia da venda, sobre o seu faturamento. Se algum pedido do período
                cair num dia sem alíquota, o imposto do período fica em branco — nunca parcial. É uma estimativa pela
                alíquota efetiva, não a apuração da guia.
              </p>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
