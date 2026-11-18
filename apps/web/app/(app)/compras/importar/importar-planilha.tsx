"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { Panel } from "../../../../components/panel";
import { formatCount } from "../../../../lib/format";
import {
  classificarAba,
  montarLinhas,
  sha256Hex,
  type ClassificacaoAba,
  type PapelColuna,
} from "../../../../lib/importacao-pedidos/colunas";
import { TAMANHO_MAXIMO_BYTES, lerPlanilha, type Aba } from "../../../../lib/importacao-pedidos/xlsx";
import { criarLoteImportacao } from "../pedidos-ja-feitos-actions";

/**
 * Etapa A da importação (D-764): ler e classificar, sem enviar o arquivo.
 *
 * O .xlsx é aberto aqui, no navegador, e só as partes de dados saem do zip —
 * as imagens embutidas dos modelos nunca são descompactadas. Ao servidor vão
 * apenas as linhas lidas (código, EAN, descrição, quantidade como estava
 * escrita, aba, linha e coluna). A sugestão de colunas é só sugestão: cada
 * papel e cada referência podem ser trocados antes de enviar.
 */

const PAPEIS: Record<PapelColuna, string> = {
  CODIGO: "Código",
  EAN: "EAN",
  NCM: "NCM",
  DESCRICAO: "Descrição",
  OBSERVACAO: "Observação",
  QUANTIDADE: "Quantidade de um pedido",
  IGNORAR: "Ignorar",
};

const LIMITE_LINHAS = 5000;

export function ImportarPlanilha(): ReactNode {
  const router = useRouter();
  const [arquivo, setArquivo] = useState<{ nome: string; sha: string } | null>(null);
  const [abas, setAbas] = useState<Aba[]>([]);
  const [incluidas, setIncluidas] = useState<Set<string>>(new Set());
  const [cls, setCls] = useState<Record<string, ClassificacaoAba>>({});
  const [lendo, setLendo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function ler(file: File): Promise<void> {
    setErro(null);
    setAbas([]);
    setArquivo(null);

    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setErro("Envie um arquivo .xlsx (Excel). Arquivos .xls antigos precisam ser salvos como .xlsx antes.");

      return;
    }

    if (file.size > TAMANHO_MAXIMO_BYTES) {
      setErro(`O arquivo tem ${formatCount(Math.round(file.size / 1024 / 1024))} MB; o limite é ${formatCount(TAMANHO_MAXIMO_BYTES / 1024 / 1024)} MB.`);

      return;
    }

    setLendo(true);

    try {
      const dados = await file.arrayBuffer();
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(dados);
      const lida = await lerPlanilha({
        texto: async (caminho) => {
          const entrada = zip.file(caminho);

          return entrada === null ? null : entrada.async("string");
        },
      });
      const novas: Record<string, ClassificacaoAba> = {};

      for (const aba of lida.abas) novas[aba.nome] = classificarAba(aba);

      setArquivo({ nome: file.name, sha: await sha256Hex(dados) });
      setAbas(lida.abas);
      setCls(novas);
      // Aba sem nenhuma coluna de quantidade começa desmarcada: é catálogo, não pedido.
      setIncluidas(new Set(lida.abas.filter((a) => novas[a.nome]?.colunas.some((c) => c.papel === "QUANTIDADE")).map((a) => a.nome)));
    } catch {
      setErro("Não foi possível ler o arquivo. Confira se é um .xlsx válido e não está protegido por senha.");
    } finally {
      setLendo(false);
    }
  }

  const linhas = useMemo(
    () =>
      abas
        .filter((a) => incluidas.has(a.nome))
        .flatMap((a) => {
          const c = cls[a.nome];

          return c === undefined ? [] : montarLinhas(a, c);
        }),
    [abas, incluidas, cls],
  );
  const semReferencia = linhas.filter((l) => l.reference === null).length;
  const aConfirmar = linhas.filter((l) => l.quantityNeedsConfirmation).length;

  function trocar(aba: string, coluna: string, mudanca: Partial<{ papel: PapelColuna; referencia: string | null }>): void {
    setCls((atual) => {
      const c = atual[aba];

      if (c === undefined) return atual;

      return {
        ...atual,
        [aba]: { ...c, colunas: c.colunas.map((x) => (x.coluna === coluna ? { ...x, ...mudanca } : x)) },
      };
    });
  }

  async function enviar(): Promise<void> {
    if (arquivo === null) return;

    setEnviando(true);
    setErro(null);

    const r = await criarLoteImportacao({
      nomeArquivo: arquivo.nome,
      sha256: arquivo.sha,
      abas: [...incluidas],
      linhas,
    });

    setEnviando(false);

    if (!r.ok || r.loteId === undefined) {
      setErro(r.message ?? "Não foi possível criar a importação.");

      return;
    }

    router.push(`/compras/importar/${r.loteId}${r.existente === true ? "?existente=1" : ""}`);
  }

  return (
    <Panel
      title="1. Ler a planilha"
      subtitle="O arquivo é lido no seu navegador. Só as linhas com quantidade são enviadas, com a aba, a linha e a coluna de origem."
    >
      <div className="sb-imp-arquivo">
        <input
          className="sb-input"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-label="Planilha de pedidos (.xlsx)"
          disabled={lendo || enviando}
          onChange={(e) => {
            const f = e.target.files?.[0];

            if (f !== undefined) void ler(f);
          }}
        />
        {lendo && <span role="status">Lendo a planilha…</span>}
      </div>

      {erro !== null && (
        <p className="sb-pjf-erro" role="alert">
          {erro}
        </p>
      )}

      {abas.length > 0 && arquivo !== null && (
        <>
          <h3 className="sb-imp-subtitulo">2. Conferir as colunas de cada aba</h3>
          <p className="sb-imp-nota">
            Código, EAN e descrição identificam o produto. Cada coluna de quantidade é um pedido: informe a referência
            quando o cabeçalho estiver vazio. Colunas de valor, preço ou peso ficam em “Ignorar”.
          </p>

          {abas.map((aba) => {
            const c = cls[aba.nome];

            if (c === undefined) return null;

            const amostra = [...aba.grade.entries()].filter(([n]) => n > c.linhaCabecalho).slice(0, 3);
            const temQuantidade = c.colunas.some((x) => x.papel === "QUANTIDADE");

            return (
              <details key={aba.nome} className="sb-imp-aba" open={incluidas.has(aba.nome)}>
                <summary>
                  <label onClick={(e) => { e.stopPropagation(); }}>
                    <input
                      type="checkbox"
                      checked={incluidas.has(aba.nome)}
                      onChange={(e) =>
                        { setIncluidas((atual) => {
                          const n = new Set(atual);

                          if (e.target.checked) n.add(aba.nome);
                          else n.delete(aba.nome);

                          return n;
                        }); }
                      }
                    />{" "}
                    <b>{aba.nome}</b>
                  </label>
                  <small>
                    {formatCount(aba.grade.size)} linhas · cabeçalho na linha {c.linhaCabecalho}
                    {!temQuantidade && " · nenhuma quantidade reconhecida (parece catálogo)"}
                    {aba.cortada && " · aba cortada em 20.000 linhas"}
                  </small>
                </summary>
                <div style={{ overflowX: "auto" }}>
                  <table className="sb-table sb-imp-colunas">
                    <thead>
                      <tr>
                        <th>Coluna</th>
                        <th>Cabeçalho</th>
                        <th>Exemplos</th>
                        <th>É</th>
                        <th>Referência do pedido</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.colunas.map((col) => (
                        <tr key={col.coluna}>
                          <td className="sb-mono">{col.coluna}</td>
                          <td>{col.cabecalho === "" ? <span className="sb-rep-mudo">sem cabeçalho</span> : col.cabecalho}</td>
                          <td className="sb-imp-exemplos">
                            {amostra
                              .map(([, l]) => l.get(col.coluna)?.texto ?? "")
                              .filter((t) => t !== "")
                              .join(" · ")}
                          </td>
                          <td>
                            <select
                              className="sb-input sb-input-sm"
                              value={col.papel}
                              aria-label={`Papel da coluna ${col.coluna}`}
                              onChange={(e) => { trocar(aba.nome, col.coluna, { papel: e.target.value as PapelColuna }); }}
                            >
                              {(Object.keys(PAPEIS) as PapelColuna[]).map((p) => (
                                <option key={p} value={p}>
                                  {PAPEIS[p]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            {col.papel === "QUANTIDADE" && (
                              <input
                                className="sb-input sb-input-sm"
                                value={col.referencia ?? ""}
                                maxLength={80}
                                placeholder="informar"
                                aria-label={`Referência do pedido da coluna ${col.coluna}`}
                                onChange={(e) => { trocar(aba.nome, col.coluna, { referencia: e.target.value.trim() === "" ? null : e.target.value }); }}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            );
          })}

          <div className="sb-imp-envio">
            <p>
              <b>{formatCount(linhas.length)}</b> quantidades em {formatCount(incluidas.size)} aba(s)
              {semReferencia > 0 && ` · ${formatCount(semReferencia)} sem referência (informe no próximo passo ou aqui)`}
              {aConfirmar > 0 && ` · ${formatCount(aConfirmar)} a confirmar (como “200 + 200”)`}
            </p>
            {linhas.length > LIMITE_LINHAS && (
              <p className="sb-pjf-erro" role="alert">
                São mais de {formatCount(LIMITE_LINHAS)} quantidades. Desmarque abas ou divida o arquivo.
              </p>
            )}
            <button
              type="button"
              className="sb-button sb-button-primary"
              disabled={enviando || linhas.length === 0 || linhas.length > LIMITE_LINHAS}
              onClick={() => void enviar()}
            >
              {enviando ? "Enviando…" : "3. Enviar para conferência"}
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}
