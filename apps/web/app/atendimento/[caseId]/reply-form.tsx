"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { applyTemplate } from "../../../lib/apply-template";
import { createClient } from "../../../lib/supabase/browser";

/**
 * Confirmação humana de resposta (Fase 7B, D-096).
 *
 * **Chama a `api` diretamente, não uma Server Action.** É o mesmo padrão já
 * usado por "confirmar NF-e" e pela narração do Copiloto (D-082): o envio é
 * comando privilegiado, e a `api` é quem tem a credencial da conta. O `web`
 * nunca fala com o Mercado Livre (`docs/ARCHITECTURE.md` secao 4).
 *
 * **O `clientRequestId` é gerado AQUI, uma vez, e reusado enquanto o texto não
 * muda.** É o que impede que um duplo-clique, um retry de rede ou um F5 no meio
 * do envio virem duas respostas ao mesmo comprador. Gerar um id novo a cada
 * clique não deduplicaria nada — seria o mesmo que não ter chave.
 */

const LIMITE = 2_000;

/**
 * Mesmo padrão dos outros comandos privilegiados chamados do navegador
 * (`confirm-apply-form.tsx`, `diagnosis-panel.tsx`): a URL da `api` vem do
 * ambiente do build, não de prop.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface ReplyTemplateOption {
  id: string;
  name: string;
  body: string;
}

export interface ReplyFormProps {
  caseId: string;
  /** Dica remota da última sincronização — nunca autorização (D-086, decisão 3). */
  remoteReplyState: string;
  remoteReplyBlockReason: string | null;
  /** Templates da organização (D-111), lidos sob RLS pelo Server Component pai. */
  templates: ReplyTemplateOption[];
  /**
   * Como os templates aparecem: `"select"` (padrão, `/atendimento/[caseId]`)
   * é o menu suspenso original. `"sidebar"` é a barra lateral com busca do
   * `/atendimento/perguntas` — mesma inserção (`inserirTemplate` abaixo), só
   * muda a apresentação. Nasce como opção, não substituição, porque a tela de
   * caso único continua caber melhor no menu — a barra lateral pede a largura
   * que só o cartão de pergunta tem.
   */
  templatesLayout?: "select" | "sidebar";
}

type Estado =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "queued" }
  | { kind: "error"; message: string };

export function ReplyForm({
  caseId,
  remoteReplyState,
  remoteReplyBlockReason,
  templates,
  templatesLayout = "select",
}: ReplyFormProps): ReactNode {
  const router = useRouter();
  const [text, setText] = useState("");
  const [estado, setEstado] = useState<Estado>({ kind: "idle" });
  // Um id por texto: enquanto a pessoa não mudar o que escreveu, reenviar é
  // sempre a MESMA tentativa.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  // D-112: o texto que a IA sugeriu, guardado para a AUDITORIA de D-096 —
  // `support_reply_attempts.suggested_text` registra o sugerido E o texto
  // final que o humano confirmou, lado a lado.
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  // Só usado no layout "sidebar" — filtra a lista, não a busca no servidor.
  const [templateSearch, setTemplateSearch] = useState("");

  const restante = LIMITE - text.length;
  const vazio = text.trim().length === 0;
  const enviando = estado.kind === "sending";

  async function enviar(): Promise<void> {
    setEstado({ kind: "sending" });

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setEstado({ kind: "error", message: "Sessão expirada — atualize a página e entre de novo." });

      return;
    }

    try {
      const response = await fetch(`${API_URL}/v1/support/cases/${caseId}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          clientRequestId: requestId,
          text: text.trim(),
          // Auditoria D-096/D-112: quando houve sugestão de IA, o texto
          // ORIGINAL sugerido viaja junto — a comparação com o texto final
          // é o que permite medir quanto o humano precisou corrigir.
          ...(aiSuggestion === null ? {} : { suggestedText: aiSuggestion }),
        }),
      });

      const body = (await response.json()) as {
        status?: string;
        error?: { message?: string };
      };

      if (!response.ok) {
        setEstado({
          kind: "error",
          message: body.error?.message ?? "Não foi possível enviar a resposta.",
        });

        return;
      }

      if (body.status === "previously_failed") {
        // Chave nova: a anterior falhou, e reenviar exige nova confirmação.
        setRequestId(crypto.randomUUID());
        setEstado({
          kind: "error",
          message: "A tentativa anterior falhou. Revise o texto e confirme de novo.",
        });

        return;
      }

      setEstado({ kind: "queued" });
      // Recarrega para mostrar a tentativa e, quando o worker terminar, a
      // mensagem no transcript.
      router.refresh();
    } catch {
      // Falha de REDE: não sabemos se a requisição chegou. Manter o mesmo
      // `requestId` é o que garante que tentar de novo não vira segunda
      // resposta — a `api` reconhece a chave e devolve o estado real.
      setEstado({
        kind: "error",
        message: "Falha de conexão. Tente de novo — a mesma confirmação não envia duas vezes.",
      });
    }
  }

  /**
   * Inserir é PRÉ-PREENCHER, nunca enviar (D-111): a pessoa edita e confirma
   * como sempre. Texto novo = tentativa nova. Compartilhada pelos dois
   * layouts — o `<select>` e a barra lateral chamam a mesma função, então as
   * duas telas erram (ou acertam) juntas, nunca uma sem a outra.
   */
  function inserirTemplate(template: ReplyTemplateOption): void {
    const result = applyTemplate(text, template.body, LIMITE);

    if (!result.applied) {
      setEstado({
        kind: "error",
        message: "O template não coube no limite de caracteres junto do que já está escrito.",
      });

      return;
    }

    setText(result.text);
    setRequestId(crypto.randomUUID());

    if (estado.kind === "error") {
      setEstado({ kind: "idle" });
    }
  }

  const termoBusca = templateSearch.trim().toLowerCase();
  const templatesFiltrados =
    termoBusca === ""
      ? templates
      : templates.filter(
          (template) => template.name.toLowerCase().includes(termoBusca) || template.body.toLowerCase().includes(termoBusca),
        );

  const compor = (
    <div style={{ display: "grid", gap: "var(--sb-space-2)", minWidth: 0 }}>
      {remoteReplyState === "BLOCKED" && (
        <p style={{ margin: 0, color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
          O Mercado Livre indicou que esta pergunta não aceita resposta
          {remoteReplyBlockReason === null ? "" : ` (${remoteReplyBlockReason})`}. O envio é
          revalidado no momento do disparo e provavelmente será recusado.
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-2)", flexWrap: "wrap" }}>
        <button
          className="sb-button"
          type="button"
          disabled={suggesting || enviando || estado.kind === "queued"}
          onClick={() => {
            // D-112 (docs/COPILOT.md secao 11): a ferramenta GERA texto; o
            // envio continua sendo o comando privilegiado de D-096, depois
            // de revisão humana — o Copiloto nunca envia.
            setSuggesting(true);

            void (async () => {
              const supabase = createClient();
              const { data } = await supabase.auth.getSession();
              const token = data.session?.access_token;

              if (token === undefined) {
                setEstado({ kind: "error", message: "Sessão expirada — atualize a página e entre de novo." });
                setSuggesting(false);

                return;
              }

              try {
                const response = await fetch(`${API_URL}/v1/copilot/query`, {
                  method: "POST",
                  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
                  body: JSON.stringify({ tool: "suggest_support_reply", input: { supportCaseId: caseId } }),
                });

                const body = (await response.json()) as {
                  data?: { suggestedText?: string };
                  error?: { message?: string };
                };

                const suggested = body.data?.suggestedText;

                if (!response.ok || suggested === undefined) {
                  setEstado({
                    kind: "error",
                    message: body.error?.message ?? "Não foi possível gerar a sugestão.",
                  });

                  return;
                }

                const applied = applyTemplate(text, suggested, LIMITE);

                if (!applied.applied) {
                  setEstado({
                    kind: "error",
                    message: "A sugestão não coube no limite junto do que já está escrito.",
                  });

                  return;
                }

                setText(applied.text);
                setAiSuggestion(suggested);
                setRequestId(crypto.randomUUID());

                if (estado.kind === "error") {
                  setEstado({ kind: "idle" });
                }
              } catch {
                setEstado({ kind: "error", message: "Falha de conexão ao gerar a sugestão." });
              } finally {
                setSuggesting(false);
              }
            })();
          }}
        >
          {suggesting ? "Gerando…" : "Sugerir com IA"}
        </button>

        {aiSuggestion !== null && (
          <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
            Sugestão de IA inserida — revise antes de enviar.
          </span>
        )}
      </div>

      {templatesLayout === "select" && templates.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-2)" }}>
          <label htmlFor="template" style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            Inserir template
          </label>
          <select
            className="sb-input"
            id="template"
            value=""
            disabled={enviando || estado.kind === "queued"}
            onChange={(event) => {
              const template = templates.find((candidate) => candidate.id === event.target.value);

              if (template !== undefined) inserirTemplate(template);
            }} style={{ maxWidth: "18rem" }}
          >
            <option value="">Escolher…</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <label htmlFor="resposta" style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Sua resposta
      </label>
      <textarea
        className="sb-input"
        id="resposta"
        value={text}
        rows={4}
        maxLength={LIMITE}
        disabled={enviando || estado.kind === "queued"}
        onChange={(event) => {
          setText(event.target.value);

          if (estado.kind === "error") {
            setEstado({ kind: "idle" });
          }
        }} style={{ width: "100%" }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-2)", flexWrap: "wrap" }}>
        <button
          className="sb-button sb-button-primary"
          type="button"
          disabled={vazio || enviando || estado.kind === "queued"}
          onClick={() => void enviar()}
        >
          {enviando ? "Enviando…" : "Enviar resposta"}
        </button>

        <span style={{ fontSize: "0.75rem", color: restante < 0 ? "var(--sb-danger)" : "var(--sb-text-soft)" }}>
          {restante} de {LIMITE} caracteres
        </span>
      </div>

      {estado.kind === "queued" && (
        <p style={{ margin: 0, fontSize: "0.8125rem" }}>
          Resposta confirmada e a caminho do Mercado Livre. Ela aparece na conversa assim que o
          envio for concluído — o resultado fica registrado em Tentativas de envio.
        </p>
      )}

      {estado.kind === "error" && (
        <p role="alert" style={{ margin: 0, color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
          {estado.message}
        </p>
      )}
    </div>
  );

  if (templatesLayout === "select") {
    return <div style={{ maxWidth: "48rem" }}>{compor}</div>;
  }

  // Layout "sidebar" (/atendimento/perguntas): a barra de templates fica ao
  // lado do texto, com busca — o mesmo `inserirTemplate` de cima, só que
  // clicado num cartão em vez de escolhido num `<select>`.
  return (
    <div className="sb-reply-sidebar-layout">
      {compor}

      <aside className="sb-reply-templates" aria-label="Modelos de resposta">
        <span className="sb-eyebrow">MODELOS DE RESPOSTA</span>

        {templates.length === 0 ? (
          <p className="sb-inbox-muted" style={{ fontSize: "0.8125rem" }}>
            Nenhum modelo cadastrado ainda.
          </p>
        ) : (
          <>
            <input
              className="sb-input"
              type="search"
              placeholder="Procurar modelo…"
              value={templateSearch}
              onChange={(event) => {
                setTemplateSearch(event.target.value);
              }}
              aria-label="Procurar modelo de resposta"
            />

            {templatesFiltrados.length === 0 ? (
              <p className="sb-inbox-muted" style={{ fontSize: "0.8125rem" }}>
                Nenhum modelo bate com a busca.
              </p>
            ) : (
              <ul className="sb-reply-templates-list">
                {templatesFiltrados.map((template) => (
                  <li key={template.id}>
                    <button
                      type="button"
                      className="sb-reply-template-item"
                      disabled={enviando || estado.kind === "queued"}
                      onClick={() => {
                        inserirTemplate(template);
                      }}
                    >
                      <b>{template.name}</b>
                      <span>{template.body}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
