import {
  ROTULO_CATEGORIA_DESPESA,
  ROTULO_REGIME_TRIBUTARIO,
  resumirOrcadoRealizado,
  toSalesMetricDate,
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
import { RemoverComConfirmacao } from "../../../../components/remover-com-confirmacao";
import { StatePill } from "../../../../components/state-pill";
import { formatBusinessDate, formatCurrency, formatPercent } from "../../../../lib/format";
import { formatarAliquota } from "../../../../lib/metas-imposto";
import { currentMembership } from "../../../../lib/request-membership";
import { createClient } from "../../../../lib/supabase/server";
import { CabecalhoDaCentral, SendoAtivado } from "../comum";
import { marcarDespesaPaga, removerDespesa, removerEntidadeFiscal } from "./actions";
import { FormularioDespesa, FormularioEntidadeFiscal, FormularioVigenciaTributaria } from "./formularios";

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
  readonly cost_center: string | null;
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

interface VigenciaFiscalRow {
  readonly id: string;
  readonly fiscal_entity_id: string;
  readonly tax_regime: RegimeTributario;
  readonly valid_from: string;
  readonly nominal_rate: number | string;
  readonly effective_sales_rate: number | string;
  readonly tax_credits_rate: number | string;
  readonly profit_tax_rate: number | string;
  readonly validated_by_accountant: boolean;
  readonly source_note: string | null;
}

function formatarCnpj(cnpj: string): string {
  if (cnpj.length !== 14) return cnpj;
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

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
  const hoje = toSalesMetricDate(new Date());

  const cabecalho = (
    <CabecalhoDaCentral
      tela="custos"
      consulta={consulta}
      titulo="Custos operacionais e fiscal"
      subtitulo="Despesas fixas e variáveis (previsto × realizado), critérios de rateio e entidades fiscais (CNPJs, regimes tributários e vigências)."
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

  const [despesasRes, entidadesRes, vigenciasRes] = await Promise.all([
    db
      .from("operational_expenses")
      .select(
        "id, name, category, cost_type, recurrence, allocation_method, planned_amount, actual_amount, competence_date, due_date, status, marketplace, cost_center, note",
      )
      .eq("organization_id", membership.organizationId)
      .order("competence_date", { ascending: false })
      .limit(200),
    db
      .from("fiscal_entities")
      .select("id, legal_name, trade_name, cnpj, tax_regime, active")
      .eq("organization_id", membership.organizationId)
      .order("legal_name", { ascending: true })
      .limit(50),
    db
      .from("fiscal_entity_tax_configs")
      .select(
        "id, fiscal_entity_id, tax_regime, valid_from, nominal_rate, effective_sales_rate, tax_credits_rate, profit_tax_rate, validated_by_accountant, source_note",
      )
      .eq("organization_id", membership.organizationId)
      .order("valid_from", { ascending: false })
      .limit(100),
  ]);

  const tabelaAusente = [despesasRes.error, entidadesRes.error, vigenciasRes.error].some(
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
          esta tela habilitará o cadastro e acompanhamento completo de despesas, rateios, orçamento × realizado e
          regimes fiscais por CNPJ.
        </SendoAtivado>
      </>
    );
  }

  const despesas = (despesasRes.data ?? []) as DespesaRow[];
  const entidades = (entidadesRes.data ?? []) as EntidadeFiscalRow[];
  const vigencias = (vigenciasRes.data ?? []) as VigenciaFiscalRow[];
  const nomeEntidadePorId = new Map(entidades.map((e) => [e.id, e.trade_name ?? e.legal_name]));

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
      ressalva:
        entidades.length === 0
          ? "usando alíquota geral de Metas e imposto"
          : `${String(vigencias.length)} vigência(s) cadastrada(s)`,
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
          subtitle="Acompanhamento de previsto × realizado, classificação de custo, recorrência e critério de rateio. Alimenta automaticamente a DRE da Central."
        >
          <div className="sb-panel-body">
            {podeEditar && (
              <details className="sb-recolhivel sb-central-bloco">
                <summary>
                  Cadastrar nova despesa operacional <small>fixa ou variável · recorrente ou pontual</small>
                </summary>
                <div className="sb-panel-body">
                  <FormularioDespesa dataPadrao={hoje} />
                </div>
              </details>
            )}

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
                      {podeEditar && <th aria-label="Ações" />}
                    </tr>
                  </thead>
                  <tbody>
                    {despesas.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <strong>{d.name}</strong>
                          {(d.cost_center !== null || d.note !== null) && (
                            <span className="sb-central-motivo">
                              {[d.cost_center, d.note].filter((x): x is string => x !== null).join(" · ")}
                            </span>
                          )}
                        </td>
                        <td>{ROTULO_CATEGORIA_DESPESA[d.category]}</td>
                        <td>{d.cost_type === "fixo" ? "Fixo" : "Variável"}</td>
                        <td>
                          {d.allocation_method === "direto" ? "Direto" : `Rateado (${d.allocation_method})`}
                          {d.marketplace !== null && d.marketplace !== "TODOS" && (
                            <span className="sb-central-motivo">{d.marketplace}</span>
                          )}
                        </td>
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
                        {podeEditar && (
                          <td>
                            <div className="sb-custos-acoes">
                              {d.status !== "paga" && d.status !== "cancelada" && (
                                <form action={marcarDespesaPaga}>
                                  <input type="hidden" name="id" value={d.id} />
                                  <input
                                    type="hidden"
                                    name="actual_amount"
                                    value={String(d.actual_amount ?? d.planned_amount)}
                                  />
                                  <button type="submit" className="sb-button">
                                    Marcar paga
                                  </button>
                                </form>
                              )}
                              <RemoverComConfirmacao
                                acao={removerDespesa}
                                campos={{ id: d.id }}
                                rotulo={`Remover ${d.name}`}
                                consequencia="A despesa deixa de entrar na DRE gerencial e no orçamento."
                              />
                            </div>
                          </td>
                        )}
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
          subtitle="Cadastre cada CNPJ com seu regime (Simples Nacional, Lucro Presumido, Lucro Real ou Configurável) e histórico de vigências."
        >
          <div className="sb-panel-body">
            {podeEditar && (
              <div className="sb-pair-grid sb-central-bloco">
                <details className="sb-recolhivel">
                  <summary>
                    Cadastrar empresa (CNPJ) <small>Simples Nacional, Lucro Presumido, Lucro Real</small>
                  </summary>
                  <div className="sb-panel-body">
                    <FormularioEntidadeFiscal />
                  </div>
                </details>

                {entidades.length > 0 && (
                  <details className="sb-recolhivel">
                    <summary>
                      Cadastrar vigência tributária <small>alíquotas, créditos e tributo sobre lucro</small>
                    </summary>
                    <div className="sb-panel-body">
                      <FormularioVigenciaTributaria
                        dataPadrao={`${hoje.slice(0, 4)}-01-01`}
                        entidades={entidades.map((e) => ({
                          id: e.id,
                          label: `${e.trade_name ?? e.legal_name} (${formatarCnpj(e.cnpj)})`,
                          regime: e.tax_regime,
                        }))}
                      />
                    </div>
                  </details>
                )}
              </div>
            )}

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
                      {podeEditar && <th aria-label="Ações" />}
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
                        {podeEditar && (
                          <td>
                            <RemoverComConfirmacao
                              acao={removerEntidadeFiscal}
                              campos={{ id: e.id }}
                              rotulo={`Remover ${e.trade_name ?? e.legal_name}`}
                              consequencia="Remove a entidade fiscal e suas vigências vinculadas."
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {vigencias.length > 0 && (
              <div className="sb-central-tabela sb-central-bloco">
                <p className="sb-texto-suave">Histórico de vigências tributárias por CNPJ</p>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Empresa</th>
                      <th>Regime</th>
                      <th>Vigência a partir de</th>
                      <th className="sb-num">Nominal</th>
                      <th className="sb-num">Efetiva vendas</th>
                      <th className="sb-num">Créditos CMV</th>
                      <th className="sb-num">Sobre lucro</th>
                      <th>Validação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vigencias.map((v) => (
                      <tr key={v.id}>
                        <td>{nomeEntidadePorId.get(v.fiscal_entity_id) ?? "Empresa"}</td>
                        <td>{ROTULO_REGIME_TRIBUTARIO[v.tax_regime]}</td>
                        <td>{formatBusinessDate(v.valid_from)}</td>
                        <td className="sb-num">{formatarAliquota(Number(v.nominal_rate))}</td>
                        <td className="sb-num">{formatarAliquota(Number(v.effective_sales_rate))}</td>
                        <td className="sb-num">{formatarAliquota(Number(v.tax_credits_rate))}</td>
                        <td className="sb-num">{formatarAliquota(Number(v.profit_tax_rate))}</td>
                        <td>
                          <StatePill
                            tone={{
                              tom: v.validated_by_accountant ? "ok" : "atencao",
                              label: v.validated_by_accountant ? "validado contabilidade" : "estimativa gerencial",
                            }}
                          />
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
