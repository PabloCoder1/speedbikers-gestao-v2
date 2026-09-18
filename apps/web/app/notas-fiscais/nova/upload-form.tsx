"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";

import { Icone } from "../../../components/icons";
import { createClient } from "../../../lib/supabase/browser";
import { describeUploadResponse } from "./describe-response";
import { MAX_BYTES, tamanhoLegivel, triar, type ArquivoTriado } from "./triagem";

/**
 * Envio de documentos de estoque — XML e PDF, um ou vários (D-375).
 *
 * Mesmo raciocínio de `apps/web/app/importacoes/nova/upload-form.tsx`: o
 * arquivo vai do navegador DIRETO para a `api` — CORS de `/v1/*` autoriza.
 * O token da sessão vai no header `Authorization`; a `api` reavalia o papel.
 *
 * **Um envio por arquivo, até três ao mesmo tempo.** A `api` responde um
 * documento por chamada (é ela que faz o hash e a idempotência). Antes os
 * envios iam um atrás do outro, porque a lista de resultados era separada da
 * fila e o paralelo embaralharia a ordem. Agora o resultado mora NA linha do
 * próprio arquivo, então a ordem de chegada não importa — e o lote do dia sobe
 * no tempo do mais lento de cada três, não na soma de todos. Três, e não
 * todos: é o que o navegador abre por origem sem enfileirar do lado dele, e
 * poupa a `api` de um pico quando alguém arrasta uma pasta inteira.
 *
 * Um arquivo recusado NÃO interrompe os outros: cada linha diz o que
 * aconteceu com o seu.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

const PARALELO = 3;

type Estado = "pronto" | "enviando" | "enviado" | "falhou";

interface ItemDaFila {
  readonly chave: string;
  readonly arquivo: File;
  readonly triado: ArquivoTriado;
  readonly estado: Estado;
  readonly mensagem: string | null;
  readonly documentId: string | null;
}

const ROTULO_DO_ESTADO: Record<Estado, string> = {
  pronto: "Pronto",
  enviando: "Enviando",
  enviado: "Recebido",
  falhou: "Não enviado",
};

export function UploadForm(): ReactNode {
  const router = useRouter();
  const entrada = useRef<HTMLInputElement | null>(null);

  const [fila, setFila] = useState<readonly ItemDaFila[]>([]);
  const [arrastando, setArrastando] = useState(false);
  const [aviso, setAviso] = useState<{ tom: "bad" | "soft"; texto: string } | null>(null);
  const [enviando, setEnviando] = useState(false);

  const prontos = fila.filter((item) => item.estado === "pronto" && item.triado.recusa === null);
  const recebidos = fila.filter((item) => item.estado === "enviado").length;

  function atualizar(chave: string, mudanca: Partial<ItemDaFila>): void {
    setFila((atual) => atual.map((item) => (item.chave === chave ? { ...item, ...mudanca } : item)));
  }

  function receber(arquivos: readonly File[]): void {
    // Mesmo nome E mesmo tamanho não entram duas vezes: escolher a mesma pasta
    // de novo, ou arrastar por cima, não duplica a fila.
    setFila((atual) => {
      const novos = arquivos
        .map((arquivo): ItemDaFila => {
          const triado = triar(arquivo);

          return {
            chave: `${triado.nome}:${String(triado.bytes)}`,
            arquivo,
            triado,
            estado: "pronto",
            mensagem: triado.recusa,
            documentId: null,
          };
        })
        .filter((item) => !atual.some((existente) => existente.chave === item.chave));

      return novos.length === 0 ? atual : [...atual, ...novos];
    });
    setAviso(null);

    // Limpa o input para que escolher o MESMO arquivo depois de removê-lo
    // dispare `change` de novo.
    if (entrada.current !== null) entrada.current.value = "";
  }

  function remover(chave: string): void {
    setFila((atual) => atual.filter((item) => item.chave !== chave));
    setAviso(null);
  }

  async function enviarUm(item: ItemDaFila, token: string): Promise<string | null> {
    atualizar(item.chave, { estado: "enviando", mensagem: null });

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
      atualizar(item.chave, { estado: "falhou", mensagem: "Não foi possível falar com o servidor." });

      return null;
    }

    const payload: unknown = await response.json().catch(() => null);
    const resultado = describeUploadResponse(response.status, payload);

    atualizar(item.chave, {
      estado: resultado.documentId === null ? "falhou" : "enviado",
      mensagem: resultado.message.text,
      documentId: resultado.documentId,
    });

    return resultado.documentId;
  }

  async function enviar(): Promise<void> {
    const lote = prontos;

    if (lote.length === 0) return;

    setAviso(null);
    setEnviando(true);

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setAviso({ tom: "bad", texto: "Sua sessão expirou. Entre de novo." });
      setEnviando(false);

      return;
    }

    const documentos: (string | null)[] = [];
    let proximo = 0;

    // Três "trabalhadores" puxando da mesma fila: quando um termina, pega o
    // próximo. Um arquivo lento não segura os outros dois.
    await Promise.all(
      Array.from({ length: Math.min(PARALELO, lote.length) }, async () => {
        while (proximo < lote.length) {
          const indice = proximo;

          proximo += 1;

          const item = lote[indice];

          if (item !== undefined) documentos[indice] = await enviarUm(item, token);
        }
      }),
    );

    setEnviando(false);

    const enviados = documentos.filter((id): id is string => id !== null);

    // Um arquivo só e aceito: a conferência dele é o próximo passo, e abrir
    // direto poupa um clique. Vários, ou qualquer recusa, e a fila fica na
    // tela — cada linha diz o que aconteceu com o seu arquivo.
    if (lote.length === 1 && enviados.length === 1 && fila.length === 1) {
      router.push(`/notas-fiscais/${String(enviados[0])}`);

      return;
    }

    setAviso(
      enviados.length === lote.length
        ? {
            tom: "soft",
            texto: `${String(enviados.length)} ${enviados.length === 1 ? "documento recebido" : "documentos recebidos"} e em leitura. Abra cada um para conferir.`,
          }
        : {
            tom: "bad",
            texto: `${String(enviados.length)} de ${String(lote.length)} arquivos foram recebidos. Veja na lista o que aconteceu com os outros.`,
          },
    );
  }

  const rotuloDoBotao = enviando
    ? "Enviando…"
    : prontos.length > 1
      ? `Enviar ${String(prontos.length)} arquivos para conferência`
      : "Enviar para conferência";

  return (
    <form
      className="sb-nf-envio-form"
      onSubmit={(event) => {
        event.preventDefault();
        void enviar();
      }}
    >
      {/*
        A área de arrastar é um `<label>`: o clique cai no input de sempre, e
        quem usa teclado ou leitor de tela continua com o controle nativo. O
        input fica visualmente escondido (`.sb-sr-only`), não removido — o
        "Escolher arquivos" desenhado é só a cara dele.
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
        <span className="sb-nf-solta-icone" aria-hidden="true">
          <Icone nome="envio" tamanho={22} />
        </span>
        <b>{arrastando ? "Solte para adicionar à lista" : "Arraste os arquivos para cá"}</b>
        <span className="sb-nf-solta-ou">ou</span>
        <span className="sb-button sb-button-primary sb-nf-solta-botao">Escolher arquivos</span>
        <span className="sb-nf-solta-regras">
          <span className="sb-nf-selo sb-nf-selo-xml">XML</span>
          <span className="sb-nf-selo sb-nf-selo-pdf">PDF</span>
          <span>vários de uma vez · até {tamanhoLegivel(MAX_BYTES)} por arquivo</span>
        </span>
        <input
          ref={entrada}
          className="sb-sr-only"
          type="file"
          multiple
          accept=".xml,.pdf,application/xml,text/xml,application/pdf"
          onChange={(event) => {
            receber([...(event.target.files ?? [])]);
          }}
        />
      </label>

      {fila.length > 0 && (
        <div className="sb-nf-fila">
          <div className="sb-nf-fila-cabeca">
            <b>
              {fila.length} {fila.length === 1 ? "arquivo" : "arquivos"}
            </b>
            {recebidos > 0 && <span>{recebidos} recebido(s)</span>}
          </div>

          <ul className="sb-nf-escolhidos">
            {fila.map((item) => {
              const estado: Estado | "recusado" = item.triado.recusa === null ? item.estado : "recusado";

              return (
                <li key={item.chave} className={`sb-nf-escolhido sb-nf-escolhido-${estado}`}>
                  <span
                    className={`sb-nf-selo ${item.triado.formato === "PDF" ? "sb-nf-selo-pdf" : item.triado.formato === "XML" ? "sb-nf-selo-xml" : "sb-nf-selo-outro"}`}
                  >
                    {item.triado.formato ?? "?"}
                  </span>

                  <div className="sb-nf-escolhido-texto">
                    <span className="sb-nf-escolhido-nome" title={item.triado.nome}>
                      {item.triado.nome}
                    </span>
                    <span className="sb-nf-escolhido-nota">
                      {tamanhoLegivel(item.triado.bytes)}
                      {item.mensagem !== null && ` · ${item.mensagem}`}
                    </span>
                  </div>

                  {item.documentId !== null ? (
                    <a className="sb-button sb-nf-escolhido-abrir" href={`/notas-fiscais/${item.documentId}`}>
                      Abrir conferência
                    </a>
                  ) : (
                    <span className={`sb-nf-estado sb-nf-estado-${estado}`}>
                      {estado === "enviando" && <span className="sb-nf-girando" aria-hidden="true" />}
                      {estado === "recusado" ? "Recusado" : ROTULO_DO_ESTADO[estado]}
                    </span>
                  )}

                  {!enviando && item.estado !== "enviado" && (
                    <button
                      className="sb-nf-remover"
                      type="button"
                      aria-label={`Tirar ${item.triado.nome} da lista`}
                      onClick={() => {
                        remover(item.chave);
                      }}
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {aviso !== null && (
        <p role="alert" className={`sb-nf-aviso sb-nf-aviso-${aviso.tom}`}>
          {aviso.texto}
        </p>
      )}

      <div className="sb-nf-envio-rodape">
        <p>
          <b>Enviar não altera o estoque.</b> Entrada ou saída sai do conteúdo: no XML e no DANFE, pelo CNPJ da
          Speed Bikers; no Pedido de Saída, pelo próprio título.
        </p>

        <div className="sb-nf-envio-acoes">
          {fila.length > 0 && !enviando && (
            <button
              className="sb-text-button"
              type="button"
              onClick={() => {
                setFila([]);
                setAviso(null);
              }}
            >
              Limpar a lista
            </button>
          )}

          <button className="sb-button sb-button-primary" type="submit" disabled={enviando || prontos.length === 0}>
            {rotuloDoBotao}
          </button>
        </div>
      </div>
    </form>
  );
}
