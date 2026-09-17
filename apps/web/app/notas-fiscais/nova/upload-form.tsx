"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { createClient } from "../../../lib/supabase/browser";
import { describeUploadResponse, type UploadMessage } from "./describe-response";
import { tamanhoLegivel, triar, type ArquivoTriado } from "./triagem";

/**
 * Envio de documentos de estoque — XML e PDF, um ou vários (D-375).
 *
 * Mesmo raciocínio de `apps/web/app/importacoes/nova/upload-form.tsx`: o
 * arquivo vai do navegador DIRETO para a `api` — CORS de `/v1/*` autoriza.
 * O token da sessão vai no header `Authorization`; a `api` reavalia o papel.
 *
 * **Um envio por arquivo, em sequência.** A `api` responde um documento por
 * chamada (é ela que faz o hash e a idempotência), e enviar em paralelo só
 * embaralharia a ordem dos resultados sem ganhar tempo perceptível no volume
 * real (o lote de um dia, não milhares). Um arquivo recusado NÃO interrompe os
 * outros: cada linha do resultado diz o que aconteceu com o seu.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

interface Resultado {
  readonly nome: string;
  readonly documentId: string | null;
  readonly mensagem: UploadMessage;
}

const TOM_RESULTADO: Record<"bad" | "soft", string> = {
  bad: "var(--sb-danger)",
  soft: "var(--sb-success)",
};

export function UploadForm(): ReactNode {
  const router = useRouter();
  const entrada = useRef<HTMLInputElement | null>(null);

  const [fila, setFila] = useState<{ arquivo: File; triado: ArquivoTriado }[]>([]);
  const [arrastando, setArrastando] = useState(false);
  const [mensagem, setMensagem] = useState<UploadMessage | null>(null);
  const [resultados, setResultados] = useState<readonly Resultado[]>([]);
  const [enviando, setEnviando] = useState<string | null>(null);

  const aceitos = fila.filter((item) => item.triado.recusa === null);

  function receber(arquivos: readonly File[]): void {
    // Mesmo nome E mesmo tamanho não entram duas vezes: escolher a mesma pasta
    // de novo, ou arrastar por cima, não duplica a fila.
    const novos = arquivos
      .map((arquivo) => ({ arquivo, triado: triar(arquivo) }))
      .filter(
        (item) =>
          !fila.some((atual) => atual.triado.nome === item.triado.nome && atual.triado.bytes === item.triado.bytes),
      );

    if (novos.length === 0) return;

    setFila([...fila, ...novos]);
    setMensagem(null);
    setResultados([]);
  }

  async function enviar(): Promise<void> {
    if (aceitos.length === 0) return;

    setMensagem(null);
    setResultados([]);

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setMensagem({ tone: "bad", text: "Sua sessão expirou. Entre de novo." });

      return;
    }

    const saida: Resultado[] = [];

    for (const item of aceitos) {
      setEnviando(item.triado.nome);

      const body = new FormData();

      body.set("file", item.arquivo);

      let response: Response;

      try {
        response = await fetch(`${API_URL}/v1/nfe-imports`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body,
        });
      } catch {
        saida.push({
          nome: item.triado.nome,
          documentId: null,
          mensagem: { tone: "bad", text: "não foi possível falar com o servidor" },
        });

        continue;
      }

      const payload: unknown = await response.json().catch(() => null);
      const resultado = describeUploadResponse(response.status, payload);

      saida.push({ nome: item.triado.nome, documentId: resultado.documentId, mensagem: resultado.message });
    }

    setEnviando(null);
    setResultados(saida);

    const enviados = saida.filter((r) => r.documentId !== null);

    // Um arquivo só e aceito: a conferência dele é o próximo passo, e abrir
    // direto poupa um clique. Vários, ou qualquer recusa, e a lista fica na
    // tela — ela é o que diz o que aconteceu com cada um.
    if (saida.length === 1 && enviados.length === 1) {
      router.push(`/notas-fiscais/${String(enviados[0]?.documentId)}`);

      return;
    }

    setFila([]);

    if (entrada.current !== null) entrada.current.value = "";

    setMensagem(
      enviados.length === saida.length
        ? { tone: "soft", text: `${String(enviados.length)} documento(s) recebido(s) e em leitura.` }
        : {
            tone: "bad",
            text: `${String(enviados.length)} de ${String(saida.length)} arquivos foram recebidos. Veja abaixo o que aconteceu com os outros.`,
          },
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void enviar();
      }}
      style={{ display: "grid", gap: "var(--sb-space-3)" }}
    >
      {/*
        A área de arrastar é um `<label>`: o clique cai no input de sempre, e
        quem usa teclado ou leitor de tela continua com o controle nativo.
      */}
      <label
        className={arrastando ? "sb-nf-solta sb-nf-solta-ativa" : "sb-nf-solta"}
        onDragOver={(event) => {
          event.preventDefault();
          setArrastando(true);
        }}
        onDragLeave={() => {
          setArrastando(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setArrastando(false);
          receber([...event.dataTransfer.files]);
        }}
      >
        <b>Arraste os arquivos aqui ou clique para escolher</b>
        <span>
          XML da NF-e e PDF (DANFE, Pedido de Saída, envio ao Full). Pode enviar vários de uma vez — até{" "}
          {tamanhoLegivel(20 * 1024 * 1024)} por arquivo.
        </span>
        <input
          ref={entrada}
          className="sb-input"
          type="file"
          multiple
          accept=".xml,.pdf,application/xml,text/xml,application/pdf"
          onChange={(event) => {
            receber([...(event.target.files ?? [])]);
          }}
          style={{ marginTop: "var(--sb-space-2)" }}
        />
      </label>

      {fila.length > 0 && (
        <ul className="sb-nf-escolhidos">
          {fila.map((item) => (
            <li
              key={`${item.triado.nome}:${String(item.triado.bytes)}`}
              className={item.triado.recusa === null ? "sb-nf-escolhido" : "sb-nf-escolhido sb-nf-escolhido-recusado"}
            >
              <span className="sb-nf-escolhido-nome">{item.triado.nome}</span>
              <span className="sb-nf-escolhido-nota">
                {item.triado.recusa ?? `${item.triado.formato ?? "formato a confirmar"} · ${tamanhoLegivel(item.triado.bytes)}`}
                {enviando === item.triado.nome && " · enviando…"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {mensagem !== null && (
        <p
          role="alert"
          style={{
            margin: 0,
            fontSize: "0.875rem",
            color: mensagem.tone === "bad" ? "var(--sb-danger)" : "var(--sb-text-soft)",
          }}
        >
          {mensagem.text}
        </p>
      )}

      {resultados.length > 0 && (
        <ul className="sb-nf-resultados">
          {resultados.map((resultado) => (
            <li
              key={resultado.nome}
              className="sb-nf-resultado"
              style={{ "--sb-nf-tom": TOM_RESULTADO[resultado.mensagem.tone] } as CSSProperties}
            >
              <b>{resultado.nome}</b>
              <span>
                {resultado.mensagem.text}
                {resultado.documentId !== null && (
                  <>
                    {" "}
                    <a className="sb-text-button" href={`/notas-fiscais/${resultado.documentId}`}>
                      abrir conferência
                    </a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "center" }}>
        <button className="sb-button sb-button-primary" type="submit" disabled={enviando !== null || aceitos.length === 0}>
          {enviando !== null
            ? "Enviando…"
            : aceitos.length > 1
              ? `Enviar ${String(aceitos.length)} arquivos`
              : "Enviar para conferência"}
        </button>

        {fila.length > 0 && enviando === null && (
          <button
            className="sb-text-button"
            type="button"
            onClick={() => {
              setFila([]);
              setResultados([]);
              setMensagem(null);

              if (entrada.current !== null) entrada.current.value = "";
            }}
          >
            Limpar a lista
          </button>
        )}
      </div>

      <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Enviar não altera o estoque. Cada arquivo é lido e fica em conferência até você vincular os itens a SKUs e
        confirmar. Entrada ou saída é decidido pelo conteúdo do documento — no XML e no DANFE, pelo CNPJ da Speed
        Bikers; no Pedido de Saída, pelo próprio título.
      </p>
    </form>
  );
}
