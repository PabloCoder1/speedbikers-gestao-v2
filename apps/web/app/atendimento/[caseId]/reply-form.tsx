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
}: ReplyFormProps): ReactNode {
  const router = useRouter();
  const [text, setText] = useState("");
  const [estado, setEstado] = useState<Estado>({ kind: "idle" });
  // Um id por texto: enquanto a pessoa não mudar o que escreveu, reenviar é
  // sempre a MESMA tentativa.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

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
        body: JSON.stringify({ clientRequestId: requestId, text: text.trim() }),
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

  return (
    <div style={{ display: "grid", gap: "var(--sb-space-2)", maxWidth: "48rem" }}>
      {remoteReplyState === "BLOCKED" && (
        <p style={{ margin: 0, color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
          O Mercado Livre indicou que esta pergunta não aceita resposta
          {remoteReplyBlockReason === null ? "" : ` (${remoteReplyBlockReason})`}. O envio é
          revalidado no momento do disparo e provavelmente será recusado.
        </p>
      )}

      {templates.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-2)" }}>
          <label htmlFor="template" style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            Inserir template
          </label>
          <select
            id="template"
            value=""
            disabled={enviando || estado.kind === "queued"}
            onChange={(event) => {
              const template = templates.find((candidate) => candidate.id === event.target.value);

              if (template === undefined) {
                return;
              }

              // Inserir é PRÉ-PREENCHER, nunca enviar (D-111): a pessoa
              // edita e confirma como sempre. Texto novo = tentativa nova.
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
            }}
            style={{
              padding: "0.375rem 0.5rem",
              border: "1px solid var(--sb-border)",
              borderRadius: "var(--sb-radius)",
              fontSize: "0.8125rem",
              maxWidth: "18rem",
            }}
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
        }}
        style={{
          width: "100%",
          padding: "0.625rem 0.75rem",
          border: "1px solid var(--sb-border)",
          borderRadius: "var(--sb-radius)",
          fontSize: "0.9375rem",
          fontFamily: "inherit",
          resize: "vertical",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-2)", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={vazio || enviando || estado.kind === "queued"}
          onClick={() => void enviar()}
          style={{
            border: "none",
            borderRadius: "var(--sb-radius)",
            background: vazio || enviando ? "var(--sb-muted)" : "var(--sb-primary)",
            color: vazio || enviando ? "var(--sb-text)" : "var(--sb-white)",
            padding: "0.5rem 1rem",
            fontSize: "0.875rem",
            cursor: vazio || enviando ? "default" : "pointer",
          }}
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
}
