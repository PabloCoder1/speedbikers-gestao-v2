"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import { formatCount, formatPercent } from "../../../lib/format";
import { APERTADO_ACIMA_DE, CAIXA_LIMITE, NOME_LIMITE, ocupacaoDaCaixa } from "../../../lib/template-filters";
import { createTemplate } from "./actions";

/**
 * Criação de template (D-111) — só renderizado para ADMIN/GESTOR.
 *
 * Virou MODAL em D-392, pelo mesmo motivo da Base de Conhecimento: o
 * formulário morava no rodapé da página, depois da lista, e numa organização
 * com vinte templates ele estava a uma rolagem inteira do botão que se
 * procurava. O gatilho agora mora ao lado do título, onde toda tela desta casa
 * põe a ação principal.
 *
 * **O contador é do tamanho da CAIXA, não do campo** (D-392): escrever 1.900
 * caracteres é permitido e o banco aceita, mas esse template só vai entrar numa
 * resposta ainda em branco — `applyTemplate` recusa o resto. O aviso aparece
 * enquanto dá para encurtar, não depois que a resposta falhou no atendimento.
 */
export function NewTemplateForm({ rotulo = "Novo template" }: { rotulo?: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const titleId = useId();
  const nomeId = useId();
  const textoId = useId();

  useEffect(() => {
    if (!open) return;

    const fecharNoEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) setOpen(false);
    };

    window.addEventListener("keydown", fecharNoEscape);

    return () => {
      window.removeEventListener("keydown", fecharNoEscape);
    };
  }, [open, busy]);

  function close(): void {
    if (!busy) setOpen(false);
  }

  function submit(): void {
    setBusy(true);
    setFeedback(null);

    void createTemplate(name, body).then((result) => {
      setBusy(false);

      if (!result.ok) {
        setFeedback({ ok: false, text: result.message ?? "Não foi possível criar o template." });

        return;
      }

      setName("");
      setBody("");
      setFeedback({ ok: true, text: "Template criado — ele já aparece para a equipe inserir na resposta." });
    });
  }

  const apertado = body.length > APERTADO_ACIMA_DE;
  const invalido = name.trim().length === 0 || body.trim().length === 0;

  return (
    <>
      <button
        className="sb-button sb-button-primary"
        type="button"
        onClick={() => {
          setFeedback(null);
          setOpen(true);
        }}
      >
        {rotulo}
      </button>

      {open && (
        <div
          className="sb-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section className="sb-modal sb-template-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <div className="sb-template-modal-head">
              <div>
                <span className="sb-modal-eyebrow">NOVO TEMPLATE</span>
                <h2 id={titleId}>Texto pronto para a equipe</h2>
              </div>
              <button className="sb-close" type="button" aria-label="Fechar" onClick={close} disabled={busy}>
                ×
              </button>
            </div>

            <p>
              O template é compartilhado pela organização e nunca envia sozinho: quem atende insere na
              caixa de resposta e edita antes de confirmar.
            </p>

            <div className="sb-template-form">
              <label className="sb-template-campo" htmlFor={`${nomeId}-nome`}>
                <span>Nome</span>
                <input
                  className="sb-input"
                  id={`${nomeId}-nome`}
                  value={name}
                  autoFocus
                  maxLength={NOME_LIMITE}
                  placeholder="Ex.: Prazo de entrega — envio Full"
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </label>

              <label className="sb-template-campo" htmlFor={`${textoId}-texto`}>
                <span>
                  Texto
                  <em className={apertado ? "sb-template-contador sb-template-contador-apertado" : "sb-template-contador"}>
                    {formatCount(body.length)} de {formatCount(CAIXA_LIMITE)} · {formatPercent(ocupacaoDaCaixa(body))} da caixa
                  </em>
                </span>
                <textarea
                  className="sb-input sb-template-textarea"
                  id={`${textoId}-texto`}
                  value={body}
                  rows={8}
                  maxLength={CAIXA_LIMITE}
                  placeholder="Escreva a resposta como ela sairia para o cliente."
                  onChange={(event) => {
                    setBody(event.target.value);
                  }}
                />
              </label>

              {apertado && (
                <p className="sb-note sb-note-atencao sb-template-nota">
                  Passando de {formatCount(APERTADO_ACIMA_DE)} caracteres, este template só costuma
                  caber numa resposta ainda em branco — com um rascunho já escrito, a inserção é
                  recusada em vez de cortar a frase no meio.
                </p>
              )}

              {feedback !== null && (
                <p
                  className={feedback.ok ? "sb-template-aviso" : "sb-template-error"}
                  role={feedback.ok ? "status" : "alert"}
                >
                  {feedback.text}
                </p>
              )}

              <div className="sb-template-form-actions">
                <button className="sb-button" type="button" disabled={busy} onClick={close}>
                  {feedback?.ok === true ? "Concluído" : "Cancelar"}
                </button>
                <button
                  className="sb-button sb-button-primary"
                  type="button"
                  disabled={busy || invalido}
                  onClick={submit}
                >
                  {busy ? "Criando…" : "Criar template"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
