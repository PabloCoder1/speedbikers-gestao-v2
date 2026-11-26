import {
  ROTULO_CATEGORIA_DESPESA,
  ROTULO_REGIME_TRIBUTARIO,
  resumirOrcadoRealizado,
  type CategoriaDespesa,
  type ClassificacaoCusto,
  type MetodoRateio,
  type RegimeTributario,
  type StatusDespesa,
} from "@sb/domain";
import { Suspense, type ReactNode } from "react";

import { CarregandoConteudo } from "../../../../components/carregando";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../components/estado-da-tela";
import { KpiStrip, type KpiCellData } from "../../../../components/kpi-strip";
import { Panel } from "../../../../components/panel";
import { StatePill } from "../../../../components/state-pill";
import { formatBusinessDate, formatCurrency, formatPercent } from "../../../../lib/format";
import { currentMembership } from "../../../../lib/request-membership";
import { createClient } from "../../../../lib/supabase/server";
import { CabecalhoDaCentral, SendoAtivado } from "../comum";

export const metadata = { title: "Custos e fiscal — Speed Bikers Gestão" };

// Sessão por cookie e RLS por quem está logado: nada aqui pode ser pré-renderizado.
export const dynamic = "force-dynamic";

type Consulta = Record<string, string | string[] | undefined>;

interface DespesaRow {
  readonly id: string;
  readonly name: string;
  readonly category: CategoriaDespesa;
  readonly cost_type: ClassificacaoCusto;
  readonly recurrence: string;
  readonly allocation_method: MetodoRateio;
  readonly planned_amount: number | string;
  readonly actual_amount: number | string | null;
  readonly competence_date: string;
  readonly due_date: string | null;
  readonly status: StatusDespesa;
  readonly marketplace: string | null;
  readonly note: string | null;
}

interface EntidadeFiscalRow {
  readonly id: string;
  readonly legal_name: string;
  readonly trade_name: string | null;
  readonly cnpj: string;
  readonly tax_regime: RegimeTributario;
  readonly active: boolean;
}

function formatarCnpj(cnpj: string): string {
  if (cnpj.length !== 14) return cnpj;
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

/**
 * Custos operacionais (fixos e variáveis) e Entidades Fiscais (CNPJs/regimes).
 *
 * Degrada graciosamente com `<SendoAtivado>` caso a migration de fundação
 * (`20261126100000_central_inteligencia_financeira_fundacao.sql`) ainda não
 * tenha sido aplicada no ambiente.
 */
export default function CustosEFiscalPage(props: { searchParams: Promise<Consulta> }): ReactNode {
  return (
    <Suspense fallback={<CarregandoConteudo rotulo="Carregando custos operacionais e entidades fiscais" />}>
      <CustosEFiscalContent {...props} />
    </Suspense>
  );
}

async function CustosEFiscalContent({ searchParams }: { searchParams: Promise<Consulta> }): Promise<ReactNode> {
  const consulta = await searchParams;
  const supabase = await createClient();
  const membership = await currentMembership();
  const podeEditar = membership.role === "ADMIN" || membership.role === "GESTOR";

  const cabecalho = (
    <CabecalhoDaCentral
      tela="custos"
      consulta={consulta}
      titulo="Custos operacionais e fiscal"
      subtitulo="Despesas fixas e variáveis (previsto × realizado), critérios de rateio e entidades fiscais (CNPJs e regimes tributários)."
    />
  );

  if (membership.organizationId === null) {
    return (
      <>
        {cabecalho}
        <EstadoDaTela tipo="permissao" titulo="Sua conta não está associada a nenhuma organização." />
      </>
    );
  }

  // Tabelas novas ainda não estão no types.ts gerado pelo MCP até a migration passar pelo Dev/CI.
  // Usamos `.from(...)` via tipagem explícita segura e verificamos `PGRST205` / `42P01`.
  const db = supabase as unknown as {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (col: string, val: string) => {
          order: (col: string, opts: { ascending: boolean }) => {
            limit: (n: number) => Promise<{ data: unknown[] | null; error: { message: string; code?: string } | null }>;
          };
        };
      };
    };
  };

  const [despesasRes, entidadesRes] = await Promise.all([
    db
      .from("operational_expenses")
      .select("id, name, category, cost_type, recurrence, allocation_method, planned_amount, actual_amount, competence_date, due_date, status, marketplace, note")
      .eq("organization_id", membership.organizationId)
      .order("competence_date", { ascending: false })
      .limit(200),
    db
      .from("fiscal_entities")
      .select("id, legal_name, trade_name, cnpj, tax_regime, active")
      .eq("organization_id", membership.organizationId)
      .order("legal_name", { ascending: true })
      .limit(50),
  ]);

  const tabelaAusente = [despesasRes.error, entidadesRes.error].some(
    (e) => e !== null && (e.code === "PGRST205" || e.code === "42P01"),
  );

  if (tabelaAusente) {
    return (
      <>
        {cabecalho}
        <SendoAtivado>
          A gestão de custos operacionais (fixos e variáveis) e entidades fiscais (CNPJs e regimes tributários) está
          pronta no código e aguarda a aplicação da migration{" "}
          <code>20261126100000_central_inteligencia_financeira_fundacao.sql</code> neste ambiente. Assim que aplicada,
          esta tela habilitará o controle completo de despesas, rateios, orçamento × realizado e regimes fiscais por CNPJ.
        </SendoAtivado>
      </>
    );
  }

  const despesas = (despesasRes.data ?? []) as DespesaRow[];
  const entidades = (entidadesRes.data ?? []) as EntidadeFiscalRow[];

  const resumo = resumirOrcadoRealizado(
    despesas.map((d) => ({
      classificacao: d.cost_type,
      status: d.status,
      valorPrevisto: Number(d.planned_amount),
      valorRealizado: d.actual_amount === null ? null : Number(d.actual_amount),
      metodoRateio: d.allocation_method,
    })),
  );

  const celulas: KpiCellData[] = [
    {
      label: "Total previsto",
      formula: "Soma do valor previsto das despesas ativas (fixas + variáveis)",
      value: formatCurrency(resumo.totalPrevisto),
      previous: null,
      ressalva: `Fixas: ${formatCurrency(resumo.fixasPrevistas)} · Variáveis: ${formatCurrency(resumo.variaveisPrevistas)}`,
    },
    {
      label: "Total realizado",
      formula: "Soma do valor efetivamente pago/realizado das despesas ativas",
      value: formatCurrency(resumo.totalRealizado),
      previous: null,
      ressalva:
        resumo.desvioPercentual === null
          ? "sem orçamento previsto para comparar"
          : `desvio: ${resumo.desvioReais >= 0 ? "+" : "−"}${formatCurrency(Math.abs(resumo.desvioReais))} (${formatPercent(Math.abs(resumo.desvioPercentual))})`,
      ...(resumo.desvioReais > 0 ? { destaque: "atencao" as const } : {}),
    },
    {
      label: "Despesas diretas × rateadas",
      formula: "Separação explícita entre despesas de uma conta específica e despesas compartilhadas",
      value: formatCurrency(resumo.totalDiretas),
      previous: null,
      ressalva: `Rateadas: ${formatCurrency(resumo.totalRateadas)}`,
    },
    {
      label: "Entidades fiscais (CNPJs)",
      formula: "Empresas cadastradas com regime tributário individualizado",
      value: String(entidades.length),
      previous: null,
      ressalva: entidades.length === 0 ? "usando alíquota geral de Metas e imposto" : "regimes individualizados ativos",
    },
  ];

  return (
    <>
      {cabecalho}

      {!podeEditar && (
        <div className="sb-note">
          <span>SÓ LEITURA</span>
          <p>Cadastrar e editar despesas operacionais e entidades fiscais é restrito a ADMIN e GESTOR.</p>
        </div>
      )}

      <KpiStrip cells={celulas} />

      <div className="sb-central-bloco">
        <Panel
          title="Despesas operacionais (fixas e variáveis)"
          subtitle="Acompanhamento de previsto × realizado, classificação de custo, recorrência e critério de rateio."
        >
          <div className="sb-panel-body">
            {despesasRes.error !== null ? (
              <EstadoDaTela
                tipo="erro"
                titulo="Não foi possível carregar as despesas"
                detalhe={despesasRes.error.message}
                acao={{ href: "/central/custos", rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
              />
            ) : despesas.length === 0 ? (
              <EstadoDaTela
                tipo="vazio"
                titulo="Nenhuma despesa operacional cadastrada"
                descricao="Cadastre custos fixos (aluguel, salários, energia, softwares, contabilidade) e variáveis (embalagens, insumos) para fechar o Resultado Operacional, a Margem Líquida e o Ponto de Equilíbrio na Central."
              />
            ) : (
              <div className="sb-central-tabela">
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Despesa</th>
                      <th>Categoria</th>
                      <th>Tipo</th>
                      <th>Rateio</th>
                      <th>Competência</th>
                      <th className="sb-num">Previsto</th>
                      <th className="sb-num">Realizado</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {despesas.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <strong>{d.name}</strong>
                          {d.note !== null && <span className="sb-central-motivo">{d.note}</span>}
                        </td>
                        <td>{ROTULO_CATEGORIA_DESPESA[d.category]}</td>
                        <td>{d.cost_type === "fixo" ? "Fixo" : "Variável"}</td>
                        <td>{d.allocation_method === "direto" ? "Direto" : `Rateado (${d.allocation_method})`}</td>
                        <td>{formatBusinessDate(d.competence_date)}</td>
                        <td className="sb-num">{formatCurrency(Number(d.planned_amount))}</td>
                        <td className="sb-num">{d.actual_amount === null ? "—" : formatCurrency(Number(d.actual_amount))}</td>
                        <td>
                          <StatePill
                            tone={{
                              tom: d.status === "paga" ? "ok" : d.status === "atrasada" ? "perigo" : "neutro",
                              label: d.status,
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Panel>
      </div>

      <div className="sb-central-bloco">
        <Panel
          title="Entidades fiscais e regimes tributários"
          subtitle="Vincule cada conta de marketplace ao seu CNPJ para respeitar Simples Nacional, Lucro Presumido ou Lucro Real com vigência histórica."
        >
          <div className="sb-panel-body">
            {entidadesRes.error !== null ? (
              <EstadoDaTela
                tipo="erro"
                titulo="Não foi possível carregar as entidades fiscais"
                detalhe={entidadesRes.error.message}
                acao={{ href: "/central/custos", rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
              />
            ) : entidades.length === 0 ? (
              <EstadoDaTela
                tipo="vazio"
                titulo="Nenhuma entidade fiscal cadastrada"
                descricao="Enquanto não houver CNPJs individualizados, a Central utiliza a alíquota efetiva geral cadastrada em Metas e imposto como estimativa gerencial."
              />
            ) : (
              <div className="sb-central-tabela">
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Empresa / Razão Social</th>
                      <th>CNPJ</th>
                      <th>Regime tributário</th>
                      <th>Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entidades.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <strong>{e.trade_name ?? e.legal_name}</strong>
                          {e.trade_name !== null && <span className="sb-central-motivo">{e.legal_name}</span>}
                        </td>
                        <td>{formatarCnpj(e.cnpj)}</td>
                        <td>{ROTULO_REGIME_TRIBUTARIO[e.tax_regime]}</td>
                        <td>
                          <StatePill tone={{ tom: e.active ? "ok" : "neutro", label: e.active ? "ativa" : "inativa" }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="sb-note sb-central-bloco">
              <span>FINALIDADE GERENCIAL</span>
              <p>
                Os cálculos tributários exibidos na Central têm finalidade gerencial para apoio à decisão. Configurações
                estimadas são sempre sinalizadas como estimativa e devem ser validadas periodicamente com a contabilidade.
              </p>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
