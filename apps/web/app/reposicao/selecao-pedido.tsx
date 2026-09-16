"use client";

import { useEffect, useState, type ReactNode } from "react";

import { formatCount, formatCurrency } from "../../lib/format";

interface Selecao {
  readonly skus: number;
  readonly unidades: number;
  readonly custo: number;
  readonly semCusto: number;
}

const VAZIA: Selecao = { skus: 0, unidades: 0, custo: 0, semCusto: 0 };

/**
 * A BARRA DE SELEÇÃO do pedido de compra (D-358).
 *
 * A tabela continua Server Component e o formulário continua um GET nativo para
 * `/compras/novo` (D-151): esta barra só OBSERVA as caixas marcadas do
 * formulário e diz o que vai para o pedido — quantos SKUs, quantas unidades e o
 * custo estimado. É o total da escolha da pessoa, não um número do catálogo:
 * este vem do SQL, nos cartões.
 *
 * Custo desconhecido não entra como zero: a barra conta à parte quantos SKUs
 * marcados estão sem custo.
 *
 * "Marcar compra agora" marca as linhas da página em ruptura ou compra urgente
 * que têm sugestão — o atalho do caso mais comum, sem esconder a escolha: as
 * caixas ficam marcadas à vista e podem ser desmarcadas uma a uma.
 */
export function SelecaoPedido({ formId }: { formId: string }): ReactNode {
  const [selecao, setSelecao] = useState<Selecao>(VAZIA);
  const [temUrgente, setTemUrgente] = useState(false);

  useEffect(() => {
    const form = document.getElementById(formId);

    if (!(form instanceof HTMLFormElement)) return;

    const caixas = (): HTMLInputElement[] =>
      Array.from(form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="sku"]'));

    const recalcular = (): void => {
      let proxima: Selecao = VAZIA;

      for (const caixa of caixas()) {
        if (!caixa.checked) continue;

        const unidades = Number(caixa.dataset.unidades ?? "0");
        const custo = caixa.dataset.custo === undefined ? null : Number(caixa.dataset.custo);

        proxima = {
          skus: proxima.skus + 1,
          unidades: proxima.unidades + unidades,
          custo: proxima.custo + (custo ?? 0),
          semCusto: proxima.semCusto + (custo === null ? 1 : 0),
        };
      }

      setSelecao(proxima);
    };

    setTemUrgente(caixas().some((caixa) => caixa.dataset.urgente === "1"));
    recalcular();
    form.addEventListener("change", recalcular);

    return () => {
      form.removeEventListener("change", recalcular);
    };
  }, [formId]);

  function marcar(filtro: (caixa: HTMLInputElement) => boolean, valor: boolean): void {
    const form = document.getElementById(formId);

    if (!(form instanceof HTMLFormElement)) return;

    for (const caixa of form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="sku"]')) {
      if (filtro(caixa)) caixa.checked = valor;
    }

    form.dispatchEvent(new Event("change"));
  }

  return (
    <div className={selecao.skus > 0 ? "sb-rep-selecao sb-rep-selecao-ativa" : "sb-rep-selecao"} aria-live="polite">
      <div className="sb-rep-selecao-resumo">
        {selecao.skus === 0 ? (
          <span>Marque as linhas para montar um pedido de compra.</span>
        ) : (
          <>
            <b>
              {formatCount(selecao.skus)} SKU(s) · {formatCount(selecao.unidades)} un
            </b>
            <span>
              custo estimado {formatCurrency(selecao.custo)}
              {selecao.semCusto > 0 && ` + ${formatCount(selecao.semCusto)} sem custo cadastrado`}
            </span>
          </>
        )}
      </div>

      <div className="sb-rep-selecao-acoes">
        {temUrgente && (
          <button
            type="button"
            className="sb-button"
            onClick={() => {
              marcar((caixa) => caixa.dataset.urgente === "1", true);
            }}
          >
            Marcar compra agora
          </button>
        )}
        {selecao.skus > 0 && (
          <button
            type="button"
            className="sb-button"
            onClick={() => {
              marcar(() => true, false);
            }}
          >
            Limpar
          </button>
        )}
        <button type="submit" form={formId} className="sb-button sb-button-primary" disabled={selecao.skus === 0}>
          Criar pedido com os selecionados →
        </button>
      </div>
    </div>
  );
}
