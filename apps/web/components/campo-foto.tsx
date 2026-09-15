"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { FOTO_TIPOS_ACEITOS, prepararFoto, removerFoto, salvarFoto } from "../lib/foto-perfil";
import { Avatar } from "./avatar";

/**
 * O campo de FOTO DE PERFIL (D-354), opcional em todo lugar.
 *
 * Dois modos, porque há dois momentos:
 *
 * - **imediato** — a pessoa já existe (gaveta de `/usuarios`, "Meu perfil"):
 *   escolher a foto já a envia e troca;
 * - **pendente** — no convite, a pessoa ainda NÃO existe: não há pasta
 *   `<user_id>/` para onde mandar. A foto fica preparada aqui e o convite a
 *   envia depois que a `api` devolve o id.
 *
 * O `<input type="file">` fica escondido dentro do rótulo com cara de botão: o
 * controle nativo do sistema operacional destoaria de todo o resto, e o rótulo
 * continua sendo o que o teclado e o leitor de tela alcançam.
 */

type Modo =
  | { tipo: "imediato"; userId: string }
  | { tipo: "pendente"; onEscolher: (foto: Blob | null) => void };

export function CampoFoto({
  nome,
  fotoAtual,
  modo,
}: {
  /** De onde saem as iniciais enquanto não há foto. */
  nome: string;
  /** Caminho salvo em `profiles.avatar_path`. */
  fotoAtual: string | null;
  modo: Modo;
}): ReactNode {
  const router = useRouter();
  const [preview, setPreview] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // O `URL.createObjectURL` segura o blob na memória até ser revogado.
  useEffect(() => {
    return () => {
      if (preview !== null) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const temFoto = preview !== null || fotoAtual !== null;

  async function escolher(arquivo: File): Promise<void> {
    setErro(null);
    setOcupado(true);

    try {
      const foto = await prepararFoto(arquivo);

      setPreview(URL.createObjectURL(foto));

      if (modo.tipo === "pendente") {
        modo.onEscolher(foto);
      } else {
        await salvarFoto(modo.userId, foto, fotoAtual);
        router.refresh();
      }
    } catch (falha) {
      setPreview(null);
      setErro(falha instanceof Error ? falha.message : "Não foi possível usar esta imagem.");
    } finally {
      setOcupado(false);
    }
  }

  async function remover(): Promise<void> {
    setErro(null);

    if (modo.tipo === "pendente" || fotoAtual === null) {
      setPreview(null);
      if (modo.tipo === "pendente") modo.onEscolher(null);

      return;
    }

    setOcupado(true);

    try {
      await removerFoto(modo.userId, fotoAtual);
      setPreview(null);
      router.refresh();
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível remover a foto.");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="sb-campo-foto">
      <Avatar nome={nome} fotoPath={fotoAtual} previewUrl={preview} tamanho="xl" />

      <div className="sb-campo-foto-acoes">
        <div className="sb-campo-foto-botoes">
          <label className={`sb-button sb-button-sm sb-campo-foto-escolher${ocupado ? " sb-campo-foto-ocupado" : ""}`}>
            {ocupado ? "Enviando…" : temFoto ? "Trocar foto" : "Adicionar foto"}
            <input
              className="sb-input sb-sr-only"
              type="file"
              accept={FOTO_TIPOS_ACEITOS}
              disabled={ocupado}
              onChange={(event) => {
                const arquivo = event.target.files?.[0];

                // Zera o valor: escolher o MESMO arquivo de novo precisa
                // disparar `change` outra vez (depois de um erro, por exemplo).
                event.target.value = "";

                if (arquivo !== undefined) void escolher(arquivo);
              }}
            />
          </label>

          {temFoto && (
            <button
              type="button"
              className="sb-text-button sb-campo-foto-remover"
              disabled={ocupado}
              onClick={() => {
                void remover();
              }}
            >
              Remover
            </button>
          )}
        </div>

        <small>Opcional. JPG, PNG ou WebP — a imagem é recortada em quadrado.</small>

        {erro !== null && (
          <span role="alert" className="sb-campo-erro">
            {erro}
          </span>
        )}
      </div>
    </div>
  );
}
