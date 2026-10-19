import { shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import { Suspense, type ReactNode } from "react";

import { CarregandoConteudo } from "../../../../components/carregando";
import { AbasDaSecao } from "../../../../components/abas-da-secao";
import { PageTitle } from "../../../../components/page-title";
import { RemoverComConfirmacao } from "../../../../components/remover-com-confirmacao";
import { Panel } from "../../../../components/panel";
import { StatePill } from "../../../../components/state-pill";
import { abasDaCentral } from "../../../../lib/central-navegacao";
import { formatBusinessDate, formatCurrency } from "../../../../lib/format";
import {
  doMarketplaceDaMeta,
  formatarAliquota,
  rotuloDoMarketplaceDaMeta,
  rotuloDoMes,
} from "../../../../lib/metas-imposto";
import { lerMetaDoMes } from "../../../../lib/central-meta";
import { carregarLimites } from "../../../../lib/limites-central";
import { currentMembership } from "../../../../lib/request-membership";
import { createClient } from "../../../../lib/supabase/server";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../components/estado-da-tela";
import { ResumoDaMeta } from "../meta";
import { remover } from "./actions";
import { FormularioAliquota, FormularioMeta, FormularioMetaDoMarketplace } from "./formularios";

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
export default function MetasPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }): ReactNode {
  return (
    <>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando metas e imposto" />}>
        <MetasContent {...props} />
      </Suspense>
    </>
  );
}

/** Remover pede confirmação, no lugar, e diz o que acontece (UX_SYSTEM §6, bloco 2). */
function BotaoRemover({
  tabela,
  id,
  rotulo,
  consequencia,
}: {
  tabela: "monthly_goals" | "monthly_goals_marketplace" | "tax_rates";
  id: string;
  rotulo: string;
  consequencia: string;
}): ReactNode {
  return <RemoverComConfirmacao acao={remover} campos={{ tabela, id }} rotulo={rotulo} consequencia={consequencia} />;
}

async function MetasContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const consulta = await searchParams;
  const supabase = await createClient();
  const membership = await currentMembership();
  const podeEditar = membership.role === "ADMIN" || membership.role === "GESTOR";
  const hoje = toSalesMetricDate(new Date());
  const mesAtual = `${hoje.slice(0, 8)}01`;

  // A situação do mês (UX_SYSTEM §6, bloco 2): a mesma leitura da central, em paralelo com as tabelas.
  const [metas, aliquotas, metasDoMarketplace, respostaMeta, limites] = await Promise.all([
    supabase.from("monthly_goals").select("id, month, revenue_goal, note").order("month", { ascending: false }).limit(24),
    supabase.from("tax_rates").select("id, valid_from, rate, note").order("valid_from", { ascending: false }).limit(50),
    // D-473 (C-66): 24 meses dos dois marketplaces.
    supabase
      .from("monthly_goals_marketplace")
      .select("id, month, marketplace, revenue_goal, note")
      .order("month", { ascending: false })
      .order("marketplace", { ascending: true })
      .limit(48),
    membership.organizationId === null
      ? Promise.resolve(null)
      : Promise.resolve(supabase.rpc("get_meta_do_mes", { p_organization_id: membership.organizationId })),
    carregarLimites(supabase, membership.organizationId),
  ]);

  // Falha ou função ausente só tiram o resumo: o cadastro continua de pé.
  const metaDoMes = respostaMeta?.error === null ? lerMetaDoMes(respostaMeta.data) : null;

  // A tabela de D-473 ausente só desliga o painel dela (a web chega antes da migration).
  const marketplaceAusente =
    metasDoMarketplace.error !== null &&
    (metasDoMarketplace.error.code === "PGRST205" || metasDoMarketplace.error.code === "42P01");

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
        />
        <AbasDaSecao rotulo="Telas da central" abas={abasDaCentral("metas", consulta)} />
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
      />
      <AbasDaSecao rotulo="Telas da central" abas={abasDaCentral("metas", consulta)} />

      {!podeEditar && (
        <div className="sb-note">
          <span>SÓ LEITURA</span>
          <p>Cadastrar e remover meta e alíquota é de ADMIN e GESTOR.</p>
        </div>
      )}

      {/* Antes de cadastrar, onde a meta do mês está (UX_SYSTEM §6, bloco 2). */}
      {metaDoMes !== null && (
        <div className="sb-central-bloco">
          <ResumoDaMeta meta={metaDoMes} atrasoDaMeta={limites.atrasoDaMeta} />
        </div>
      )}

      <div className="sb-pair-grid">
        <Panel
          title="Meta geral de faturamento"
          subtitle="Uma por mês, da empresa inteira: Mercado Livre e Shopee. Cadastrar de novo o mesmo mês corrige a meta."
        >
          <div className="sb-panel-body">
            {podeEditar && <FormularioMeta mesPadrao={mesAtual.slice(0, 7)} />}

            {metas.error !== null ? (
              <EstadoDaTela
                tipo="erro"
                titulo="Não foi possível carregar as metas"
                detalhe={metas.error.message}
                acao={{ href: "/central/metas", rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
              />
            ) : metas.data.length === 0 ? (
              <EstadoDaTela
                tipo="vazio"
                titulo="Nenhuma meta cadastrada."
                descricao="Sem meta, a central mostra a projeção do mês sozinha."
              />
            ) : (
              <table className="sb-table sb-cadastro-tabela">
                <thead>
                  <tr>
                    <th>Mês</th>
                    <th className="sb-num">Meta</th>
                    <th>Observação</th>
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
                          <BotaoRemover
                            tabela="monthly_goals"
                            id={m.id}
                            rotulo={`Remover a meta de ${rotuloDoMes(m.month)}`}
                            consequencia="A meta sai, e a central mostra só a projeção desse mês."
                          />
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
              <EstadoDaTela
                tipo="erro"
                titulo="Não foi possível carregar as alíquotas"
                detalhe={aliquotas.error.message}
                acao={{ href: "/central/metas", rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
              />
            ) : aliquotas.data.length === 0 ? (
              <EstadoDaTela tipo="vazio" titulo="Nenhuma alíquota cadastrada." />
            ) : (
              <table className="sb-table sb-cadastro-tabela">
                <thead>
                  <tr>
                    <th>Vigência</th>
                    <th className="sb-num">Alíquota</th>
                    <th>Observação</th>
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
                              consequencia="Os dias dela passam a usar a alíquota anterior; sem anterior, o imposto desses dias fica em branco na central."
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

      <div className="sb-central-bloco">
        <Panel
          title="Meta por marketplace"
          subtitle="Uma por mês para o Mercado Livre e outra para a Shopee, ao lado da geral. Cadastrar de novo o mesmo mês e marketplace corrige a meta."
        >
          <div className="sb-panel-body">
            {marketplaceAusente ? (
              <div className="sb-note">
                <span>SENDO ATIVADO</span>
                <p>
                  As metas por marketplace estão sendo ativadas neste ambiente: o banco ainda não recebeu a tabela de
                  D-473. A meta geral e a alíquota acima já funcionam.
                </p>
              </div>
            ) : (
              <>
                {podeEditar && <FormularioMetaDoMarketplace mesPadrao={mesAtual.slice(0, 7)} />}

                {metasDoMarketplace.error !== null ? (
                  <EstadoDaTela
                    tipo="erro"
                    titulo="Não foi possível carregar as metas por marketplace"
                    detalhe={metasDoMarketplace.error.message}
                    acao={{ href: "/central/metas", rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
                  />
                ) : metasDoMarketplace.data.length === 0 ? (
                  <EstadoDaTela
                    tipo="vazio"
                    titulo="Nenhuma meta por marketplace cadastrada."
                    descricao="Sem elas, a central mostra o realizado de cada marketplace sem meta para comparar."
                  />
                ) : (
                  <div className="sb-cadastro-rolagem">
                    <table className="sb-table sb-cadastro-tabela" aria-label="Metas por marketplace">
                      <thead>
                        <tr>
                          <th>Mês</th>
                          <th>Marketplace</th>
                          <th className="sb-num">Meta</th>
                          <th>Observação</th>
                          {podeEditar && <th aria-label="Ações" />}
                        </tr>
                      </thead>
                      <tbody>
                        {metasDoMarketplace.data.map((m) => (
                          <tr key={m.id}>
                            <td>
                              {rotuloDoMes(m.month)}{" "}
                              {m.month === mesAtual && <StatePill tone={{ tom: "info", label: "mês atual" }} />}
                            </td>
                            <td>{rotuloDoMarketplaceDaMeta(m.marketplace)}</td>
                            <td className="sb-num">{formatCurrency(m.revenue_goal)}</td>
                            <td className="sb-texto-suave">{m.note ?? "—"}</td>
                            {podeEditar && (
                              <td>
                                <BotaoRemover
                                  tabela="monthly_goals_marketplace"
                                  id={m.id}
                                  rotulo={`Remover a meta ${doMarketplaceDaMeta(m.marketplace)} de ${rotuloDoMes(m.month)}`}
                                  consequencia="A meta sai, e a central mostra o realizado desse marketplace sem meta para comparar."
                                />
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            <div className="sb-note sb-central-bloco">
              <span>A GERAL E A SHOPEE</span>
              <p>
                A meta geral mede a receita do Mercado Livre e da Shopee juntos, e cada marketplace é medido contra a
                meta dele. Enquanto não houver loja Shopee real com pedidos lidos, a geral é só o Mercado Livre: a
                Shopee passa a somar a partir da primeira leitura de pedidos da loja real — num mês que atravessa essa
                data, a geral muda de base no meio do mês.
              </p>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
