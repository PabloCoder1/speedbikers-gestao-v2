"use client";

import {
  CATEGORIAS_DESPESA,
  ROTULO_CATEGORIA_DESPESA,
  ROTULO_REGIME_TRIBUTARIO,
  type RegimeTributario,
} from "@sb/domain";
import { useActionState, type ReactNode } from "react";

import { METODOS_RATEIO, RECORRENCIAS_DESPESA, REGIMES_TRIBUTARIOS, STATUS_DESPESA } from "../../../../lib/custos-fiscal";
import { Campo, Mensagem } from "../metas/formularios";
import type { ResultadoDoCadastro } from "../metas/actions";
import { salvarDespesa, salvarEntidadeFiscal, salvarVigenciaTributaria } from "./actions";

const INICIAL: ResultadoDoCadastro = { ok: false, mensagem: null, erros: {} };

export function FormularioDespesa({ dataPadrao }: { dataPadrao: string }): ReactNode {
  const [resultado, enviar, salvando] = useActionState(salvarDespesa, INICIAL);

  return (
    <form action={enviar} className="sb-cadastro-form" aria-label="Cadastrar despesa operacional">
      <p className="sb-form-legenda">
        Despesas recorrentes mensais usam chave anti-duplicidade na mesma competência e categoria.
      </p>

      <div className="sb-form-grade-dupla">
        <Campo nome="name" rotulo="Nome da despesa" dica="Ex.: Aluguel galpão, Folha salarial, Energia" erro={resultado.erros.name}>
          {(props) => <input {...props} className="sb-input" name="name" maxLength={140} required />}
        </Campo>

        <Campo nome="category" rotulo="Categoria" dica="Classificação gerencial na DRE." erro={resultado.erros.category}>
          {(props) => (
            <select {...props} className="sb-input" name="category" defaultValue="aluguel" required>
              {CATEGORIAS_DESPESA.map((cat) => (
                <option key={cat} value={cat}>
                  {ROTULO_CATEGORIA_DESPESA[cat]}
                </option>
              ))}
            </select>
          )}
        </Campo>

        <Campo nome="cost_type" rotulo="Classificação" dica="Fixo entra abaixo da Margem de Contribuição; Variável entra antes." erro={resultado.erros.cost_type}>
          {(props) => (
            <select {...props} className="sb-input" name="cost_type" defaultValue="fixo" required>
              <option value="fixo">Custo fixo operacional</option>
              <option value="variavel">Custo variável operacional</option>
            </select>
          )}
        </Campo>

        <Campo nome="recurrence" rotulo="Recorrência" dica="Frequência esperada do lançamento." erro={resultado.erros.recurrence}>
          {(props) => (
            <select {...props} className="sb-input" name="recurrence" defaultValue="mensal" required>
              {RECORRENCIAS_DESPESA.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.rotulo}
                </option>
              ))}
            </select>
          )}
        </Campo>

        <Campo nome="planned_amount" rotulo="Valor previsto (R$)" dica="Orçamento esperado. Ex.: 8.500,00" erro={resultado.erros.planned_amount}>
          {(props) => <input {...props} className="sb-input" name="planned_amount" inputMode="decimal" required />}
        </Campo>

        <Campo nome="actual_amount" rotulo="Valor realizado (R$, opcional)" dica="Preencha quando o valor real já estiver fechado." erro={resultado.erros.actual_amount}>
          {(props) => <input {...props} className="sb-input" name="actual_amount" inputMode="decimal" />}
        </Campo>

        <Campo nome="competence_date" rotulo="Data de competência" dica="Mês/dia ao qual o custo pertence na DRE." erro={resultado.erros.competence_date}>
          {(props) => <input {...props} className="sb-input" type="date" name="competence_date" defaultValue={dataPadrao} required />}
        </Campo>

        <Campo nome="due_date" rotulo="Vencimento (opcional)" dica="Data de vencimento para controle de caixa." erro={resultado.erros.due_date}>
          {(props) => <input {...props} className="sb-input" type="date" name="due_date" />}
        </Campo>

        <Campo nome="status" rotulo="Status" dica="Canceladas não entram na DRE nem no orçamento." erro={resultado.erros.status}>
          {(props) => (
            <select {...props} className="sb-input" name="status" defaultValue="prevista" required>
              {STATUS_DESPESA.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.rotulo}
                </option>
              ))}
            </select>
          )}
        </Campo>

        <Campo nome="allocation_method" rotulo="Critério de rateio" dica="Identifica se a despesa é direta ou rateada entre canais." erro={resultado.erros.allocation_method}>
          {(props) => (
            <select {...props} className="sb-input" name="allocation_method" defaultValue="faturamento" required>
              {METODOS_RATEIO.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.rotulo}
                </option>
              ))}
            </select>
          )}
        </Campo>

        <Campo nome="marketplace" rotulo="Marketplace vinculado" dica="Para despesas diretas de um canal ou compartilhadas." erro={resultado.erros.marketplace}>
          {(props) => (
            <select {...props} className="sb-input" name="marketplace" defaultValue="TODOS">
              <option value="TODOS">Todos (compartilhada)</option>
              <option value="MERCADO_LIVRE">Mercado Livre</option>
              <option value="SHOPEE">Shopee</option>
            </select>
          )}
        </Campo>

        <Campo nome="cost_center" rotulo="Centro de custo (opcional)" dica="Ex.: Operação, Administrativo, Logística, TI" erro={resultado.erros.cost_center}>
          {(props) => <input {...props} className="sb-input" name="cost_center" maxLength={100} />}
        </Campo>
      </div>

      <Campo nome="note" rotulo="Observação (opcional)" dica="Até 300 caracteres." erro={resultado.erros.note}>
        {(props) => <input {...props} className="sb-input" name="note" maxLength={300} />}
      </Campo>

      <div className="sb-cadastro-acoes">
        <button type="submit" className="sb-button sb-button-primary" disabled={salvando}>
          {salvando ? "Salvando…" : "Cadastrar despesa"}
        </button>
        <Mensagem resultado={resultado} />
      </div>
    </form>
  );
}

export function FormularioEntidadeFiscal(): ReactNode {
  const [resultado, enviar, salvando] = useActionState(salvarEntidadeFiscal, INICIAL);

  return (
    <form action={enviar} className="sb-cadastro-form" aria-label="Cadastrar entidade fiscal">
      <div className="sb-form-grade-dupla">
        <Campo nome="legal_name" rotulo="Razão social" dica="Nome empresarial oficial do CNPJ." erro={resultado.erros.legal_name}>
          {(props) => <input {...props} className="sb-input" name="legal_name" maxLength={160} required />}
        </Campo>

        <Campo nome="trade_name" rotulo="Nome fantasia (opcional)" dica="Identificação curta nas telas." erro={resultado.erros.trade_name}>
          {(props) => <input {...props} className="sb-input" name="trade_name" maxLength={160} />}
        </Campo>

        <Campo nome="cnpj" rotulo="CNPJ" dica="14 dígitos (com ou sem máscara). Validado por dígitos verificadores." erro={resultado.erros.cnpj}>
          {(props) => <input {...props} className="sb-input" name="cnpj" placeholder="00.000.000/0001-00" required />}
        </Campo>

        <Campo nome="tax_regime" rotulo="Regime tributário" dica="Define como os tributos e créditos são apurados." erro={resultado.erros.tax_regime}>
          {(props) => (
            <select {...props} className="sb-input" name="tax_regime" defaultValue="simples_nacional" required>
              {REGIMES_TRIBUTARIOS.map((r) => (
                <option key={r} value={r}>
                  {ROTULO_REGIME_TRIBUTARIO[r]}
                </option>
              ))}
            </select>
          )}
        </Campo>
      </div>

      <Campo nome="note" rotulo="Observação (opcional)" dica="Ex.: Matriz SP, filial Full, validação contábil." erro={resultado.erros.note}>
        {(props) => <input {...props} className="sb-input" name="note" maxLength={300} />}
      </Campo>

      <div className="sb-cadastro-acoes">
        <button type="submit" className="sb-button sb-button-primary" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar entidade fiscal"}
        </button>
        <Mensagem resultado={resultado} />
      </div>
    </form>
  );
}

export function FormularioVigenciaTributaria({
  entidades,
  dataPadrao,
}: {
  entidades: readonly { readonly id: string; readonly label: string; readonly regime: RegimeTributario }[];
  dataPadrao: string;
}): ReactNode {
  const [resultado, enviar, salvando] = useActionState(salvarVigenciaTributaria, INICIAL);

  if (entidades.length === 0) return null;

  return (
    <form action={enviar} className="sb-cadastro-form" aria-label="Cadastrar vigência tributária por CNPJ">
      <p className="sb-form-legenda">
        Nova vigência preserva o histórico dos meses anteriores. Em Lucro Real, informe também créditos sobre compras e tributo sobre lucro.
      </p>

      <div className="sb-form-grade-dupla">
        <Campo nome="fiscal_entity_id" rotulo="Empresa (CNPJ)" dica="Entidade fiscal à qual esta vigência pertence." erro={resultado.erros.fiscal_entity_id}>
          {(props) => (
            <select {...props} className="sb-input" name="fiscal_entity_id" required>
              {entidades.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          )}
        </Campo>

        <Campo nome="tax_regime" rotulo="Regime nesta vigência" dica="Permite registrar mudança de regime em anos diferentes." erro={resultado.erros.tax_regime}>
          {(props) => (
            <select {...props} className="sb-input" name="tax_regime" defaultValue={entidades[0]?.regime ?? "simples_nacional"} required>
              {REGIMES_TRIBUTARIOS.map((r) => (
                <option key={r} value={r}>
                  {ROTULO_REGIME_TRIBUTARIO[r]}
                </option>
              ))}
            </select>
          )}
        </Campo>

        <Campo nome="valid_from" rotulo="Vigência a partir de" dica="Data inicial de aplicação desta alíquota." erro={resultado.erros.valid_from}>
          {(props) => <input {...props} className="sb-input" type="date" name="valid_from" defaultValue={dataPadrao} required />}
        </Campo>

        <Campo nome="nominal_rate" rotulo="Alíquota nominal (%)" dica="Ex.: 9,5 (Simples) ou 27,25 (Lucro Real)." erro={resultado.erros.nominal_rate}>
          {(props) => <input {...props} className="sb-input" name="nominal_rate" inputMode="decimal" required />}
        </Campo>

        <Campo nome="effective_sales_rate" rotulo="Alíquota efetiva sobre vendas (%)" dica="Alíquota prática incidente sobre o faturamento." erro={resultado.erros.effective_sales_rate}>
          {(props) => <input {...props} className="sb-input" name="effective_sales_rate" inputMode="decimal" required />}
        </Campo>

        <Campo nome="tax_credits_rate" rotulo="Créditos tributários sobre CMV (%, opcional)" dica="Aplicável ao Lucro Real (PIS/COFINS/ICMS). Padrão: 0." erro={resultado.erros.tax_credits_rate}>
          {(props) => <input {...props} className="sb-input" name="tax_credits_rate" inputMode="decimal" defaultValue="0" />}
        </Campo>

        <Campo nome="profit_tax_rate" rotulo="Tributos sobre lucro (%, opcional)" dica="IRPJ/CSLL sobre lucro operacional (Lucro Real) ou presunção." erro={resultado.erros.profit_tax_rate}>
          {(props) => <input {...props} className="sb-input" name="profit_tax_rate" inputMode="decimal" defaultValue="0" />}
        </Campo>

        <Campo nome="source_note" rotulo="Origem / observação (opcional)" dica="Ex.: Apuração DAS outubro, validação contador." erro={resultado.erros.source_note}>
          {(props) => <input {...props} className="sb-input" name="source_note" maxLength={300} />}
        </Campo>
      </div>

      <label className="sb-checkbox-linha">
        <input type="checkbox" name="validated_by_accountant" />
        <span>Configuração validada com a contabilidade (caso desmarcado, exibe como estimativa gerencial)</span>
      </label>

      <div className="sb-cadastro-acoes">
        <button type="submit" className="sb-button sb-button-primary" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar vigência tributária"}
        </button>
        <Mensagem resultado={resultado} />
      </div>
    </form>
  );
}
