import {
  ROTULO_CATEGORIA_DESPESA,
  ROTULO_REGIME_TRIBUTARIO,
  ratearDespesa,
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
import { resumirRegimeCaixa } from "../../../../lib/custos-fiscal";
import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "../../../../lib/format";
import { formatarAliquota, rotuloDoMes } from "../../../../lib/metas-imposto";
import { currentMembership } from "../../../../lib/request-membership";
import { createClient } from "../../../../lib/supabase/server";
import { CabecalhoDaCentral, SendoAtivado } from "../comum";
import {
  marcarDespesaPaga,
  removerDespesa,
  removerEntidadeFiscal,
  removerVinculoContaEntidade,
} from "./actions";
import { ExportarDespesasCsv } from "./exportar-despesas";
import {
  FormularioDespesa,
  FormularioEntidadeFiscal,
  FormularioFechamentoMensal,
  FormularioGerarRecorrentes,
  FormularioVigenciaTributaria,
  FormularioVinculoConta,
} from "./formularios";

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

interface VinculoContaRow {
  readonly id: string;
  readonly fiscal_entity_id: string;
  readonly marketplace: "MERCADO_LIVRE" | "SHOPEE";
  readonly ml_account_id: string | null;
  readonly shopee_shop_id: string | null;
}

interface FechamentoMensalRow {
  readonly id: string;
  readonly month: string;
  readonly status: "aberto" | "fechado" | "reaberto";
  readonly notes: string | null;
  readonly closed_at: string | null;
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

  const [despesasRes, entidadesRes, vigenciasRes, vinculosRes, fechamentosRes, mlContasRes, shopeeLojasRes] =
    await Promise.all([
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
      db
        .from("fiscal_entity_accounts")
        .select("id, fiscal_entity_id, marketplace, ml_account_id, shopee_shop_id")
        .eq("organization_id", membership.organizationId)
        .order("created_at", { ascending: false })
        .limit(100),
      db
        .from("monthly_financial_closings")
        .select("id, month, status, notes, closed_at")
        .eq("organization_id", membership.organizationId)
        .order("month", { ascending: false })
        .limit(24),
      supabase.from("ml_accounts").select("id, label").order("label", { ascending: true }),
      supabase.from("shopee_shops").select("id, shop_name, shop_id").order("shop_name", { ascending: true }),
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
          <code>20261126180000_central_inteligencia_financeira_fundacao.sql</code> neste ambiente. Assim que aplicada,
          esta tela habilitará o cadastro e acompanhamento completo de despesas, rateios, orçamento × realizado e
          regimes fiscais por CNPJ.
        </SendoAtivado>
      </>
    );
  }

  const despesas = (despesasRes.data ?? []) as DespesaRow[];
  const entidades = (entidadesRes.data ?? []) as EntidadeFiscalRow[];
  const vigencias = (vigenciasRes.data ?? []) as VigenciaFiscalRow[];
  const vinculos = (vinculosRes.data ?? []) as VinculoContaRow[];
  const fechamentos = (fechamentosRes.data ?? []) as FechamentoMensalRow[];
  const mlContas = mlContasRes.data ?? [];
  const shopeeLojas = shopeeLojasRes.data ?? [];

  const nomeEntidadePorId = new Map(entidades.map((e) => [e.id, e.trade_name ?? e.legal_name]));
  const nomeMlPorId = new Map(mlContas.map((c) => [c.id, c.label]));
  const nomeShopeePorId = new Map(shopeeLojas.map((s) => [s.id, s.shop_name ?? `Shopee #${String(s.shop_id)}`]));
  const contasDisponiveis = [
    ...mlContas.map((c) => ({ ref: `MERCADO_LIVRE:${c.id}`, label: `Mercado Livre · ${c.label}` })),
    ...shopeeLojas.map((s) => ({
      ref: `SHOPEE:${s.id}`,
      label: `Shopee · ${s.shop_name ?? `#${String(s.shop_id)}`}`,
    })),
  ];

  const resumo = resumirOrcadoRealizado(
    despesas.map((d) => ({
      classificacao: d.cost_type,
      status: d.status,
      valorPrevisto: Number(d.planned_amount),
      valorRealizado: d.actual_amount === null ? null : Number(d.actual_amount),
      metodoRateio: d.allocation_method,
    })),
  );
  const caixa = resumirRegimeCaixa(despesas, hoje);
  const previaRateio =
    resumo.totalRateadas > 0 && contasDisponiveis.length > 0
      ? ratearDespesa(
          resumo.totalRateadas,
          "faturamento",
          contasDisponiveis.map((c) => ({ destinoId: c.ref, rotulo: c.label, peso: 1 })),
        )
      : null;

  const celulasCaixa: KpiCellData[] = [
    {
      label: "Pago no caixa",
      formula: "Despesas marcadas como pagas (saída efetiva de caixa)",
      value: formatCurrency(caixa.pagoNoCaixa),
      previous: null,
      ressalva: `${formatCount(caixa.qtdPagas)} lançamento(s) quitado(s)`,
    },
    {
      label: "A vencer (em aberto)",
      formula: "Despesas previstas com vencimento futuro ou sem vencimento definido",
      value: formatCurrency(caixa.aVencerEmAberto),
      previous: null,
      ressalva: `${formatCount(caixa.qtdAVencer)} compromisso(s) futuro(s)`,
    },
    {
      label: "Vencidas / em atraso",
      formula: "Despesas marcadas como atrasadas ou previstas com vencimento anterior a hoje",
      value: formatCurrency(caixa.vencidasEmAtraso),
      previous: null,
      ressalva:
        caixa.qtdAtrasadas === 0
          ? "nenhuma conta em atraso"
          : `${formatCount(caixa.qtdAtrasadas)} conta(s) vencida(s) exigem atenção`,
      ...(caixa.qtdAtrasadas > 0 ? { destaque: "perigo" as const } : {}),
    },
  ];

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

      <section aria-label="Visão por regime de caixa" className="sb-central-bloco">
        <div className="sb-section-label">
          <span>Regime de caixa × competência</span>
          <span className="sb-section-note">
            lucro gerencial (competência) não é saldo em caixa · abaixo, a posição real de pagamentos
          </span>
        </div>
        <KpiStrip cells={celulasCaixa} />
      </section>

      <div className="sb-central-bloco">
        <Panel
          title="Despesas operacionais (fixas e variáveis)"
          subtitle="Acompanhamento de previsto × realizado, classificação de custo, recorrência e critério de rateio. Alimenta automaticamente a DRE da Central."
          aside={<ExportarDespesasCsv despesas={despesas} />}
        >
          <div className="sb-panel-body">
            {podeEditar && (
              <div className="sb-pair-grid sb-central-bloco">
                <details className="sb-recolhivel">
                  <summary>
                    Cadastrar nova despesa operacional <small>fixa ou variável · recorrente ou pontual</small>
                  </summary>
                  <div className="sb-panel-body">
                    <FormularioDespesa dataPadrao={hoje} />
                  </div>
                </details>

                <details className="sb-recolhivel">
                  <summary>
                    Gerar recorrentes do próximo mês <small>anti-duplicidade automática por competência</small>
                  </summary>
                  <div className="sb-panel-body">
                    <FormularioGerarRecorrentes mesPadrao={hoje.slice(0, 7)} />
                  </div>
                </details>
              </div>
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

            {previaRateio !== null && previaRateio.ok && (
              <div className="sb-central-tabela sb-central-bloco">
                <p className="sb-texto-suave">
                  Prévia de rateio igualitário das despesas compartilhadas ({formatCurrency(previaRateio.total)}) entre as{" "}
                  {formatCount(contasDisponiveis.length)} contas cadastradas — despesas diretas permanecem isoladas na sua conta.
                </p>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Conta / Canal</th>
                      <th>Origem</th>
                      <th className="sb-num">Participação</th>
                      <th className="sb-num">Parcela rateada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previaRateio.parcelas.map((p) => (
                      <tr key={p.destinoId}>
                        <td>{p.rotulo}</td>
                        <td>
                          <StatePill tone={{ tom: "info", label: p.origem }} />
                        </td>
                        <td className="sb-num">{formatPercent(p.percentual)}</td>
                        <td className="sb-num">{formatCurrency(p.valor)}</td>
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

            {podeEditar && entidades.length > 0 && contasDisponiveis.length > 0 && (
              <details className="sb-recolhivel sb-central-bloco">
                <summary>
                  Vincular conta de marketplace a um CNPJ <small>cada conta pertence a uma única entidade fiscal</small>
                </summary>
                <div className="sb-panel-body">
                  <FormularioVinculoConta
                    entidades={entidades.map((e) => ({
                      id: e.id,
                      label: `${e.trade_name ?? e.legal_name} (${formatarCnpj(e.cnpj)})`,
                    }))}
                    contas={contasDisponiveis}
                  />
                </div>
              </details>
            )}

            {vinculos.length > 0 && (
              <div className="sb-central-tabela sb-central-bloco">
                <p className="sb-texto-suave">Contas de marketplace vinculadas a CNPJs</p>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Marketplace</th>
                      <th>Conta / Loja</th>
                      <th>Entidade fiscal (CNPJ)</th>
                      {podeEditar && <th aria-label="Ações" />}
                    </tr>
                  </thead>
                  <tbody>
                    {vinculos.map((v) => {
                      const contaNome =
                        v.marketplace === "MERCADO_LIVRE"
                          ? (nomeMlPorId.get(v.ml_account_id ?? "") ?? v.ml_account_id ?? "—")
                          : (nomeShopeePorId.get(v.shopee_shop_id ?? "") ?? v.shopee_shop_id ?? "—");

                      return (
                        <tr key={v.id}>
                          <td>{v.marketplace === "MERCADO_LIVRE" ? "Mercado Livre" : "Shopee"}</td>
                          <td>{contaNome}</td>
                          <td>{nomeEntidadePorId.get(v.fiscal_entity_id) ?? "Empresa"}</td>
                          {podeEditar && (
                            <td>
                              <RemoverComConfirmacao
                                acao={removerVinculoContaEntidade}
                                campos={{ id: v.id }}
                                rotulo={`Desvincular ${contaNome}`}
                                consequencia="A conta deixa de estar associada a este CNPJ."
                              />
                            </td>
                          )}
                        </tr>
                      );
                    })}
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

      <div className="sb-central-bloco">
        <Panel
          title="Fechamento financeiro mensal"
          subtitle="Registre o fechamento auditável de cada competência com data, responsável e proteção contra alterações retroativas sem rastro."
        >
          <div className="sb-panel-body">
            {podeEditar && (
              <details className="sb-recolhivel sb-central-bloco">
                <summary>
                  Registrar fechamento ou reabertura de competência <small>controle mensal auditável</small>
                </summary>
                <div className="sb-panel-body">
                  <FormularioFechamentoMensal mesPadrao={hoje.slice(0, 7)} />
                </div>
              </details>
            )}

            {fechamentos.length === 0 ? (
              <EstadoDaTela
                tipo="vazio"
                titulo="Nenhuma competência fechada ainda"
                descricao="Ao encerrar um mês e conferir despesas e impostos, registre o fechamento mensal para manter histórico auditável."
              />
            ) : (
              <div className="sb-central-tabela">
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Competência</th>
                      <th>Status</th>
                      <th>Fechado em</th>
                      <th>Notas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fechamentos.map((f) => (
                      <tr key={f.id}>
                        <td>{rotuloDoMes(f.month)}</td>
                        <td>
                          <StatePill
                            tone={{
                              tom: f.status === "fechado" ? "ok" : f.status === "reaberto" ? "atencao" : "neutro",
                              label: f.status,
                            }}
                          />
                        </td>
                        <td>
                          {f.closed_at === null
                            ? "—"
                            : new Date(f.closed_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}
                        </td>
                        <td className="sb-texto-suave">{f.notes ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
