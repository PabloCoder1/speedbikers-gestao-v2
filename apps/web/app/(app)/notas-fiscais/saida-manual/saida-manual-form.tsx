"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { lerTokenDeSessao } from "../../../../lib/chamar-api";
import { formatCount } from "../../../../lib/format";
import { termoSeguroParaOr } from "../../../../lib/postgrest-search";
import {
  LOTE_CONSULTA_SAIDA,
  MAX_CHAVES_IMPORTACAO,
  MAX_ITENS,
  OBSERVACAO_MAX,
  TIPOS_DE_SAIDA,
  chaveDoSku,
  lerListaDeSkus,
  mensagemDaApi,
  particionarEmLotes,
  quantidadeValida,
  respostaDeSaidaValida,
  somarQuantidadeNoLimite,
  type TipoDeSaida,
} from "../../../../lib/saida-manual";
import { createClient } from "../../../../lib/supabase/browser";

/**
 * Saída Manual (D-766) — o "Criar Saída" do UpSeller: armazém, tipo de saída,
 * observação e a lista de SKUs com quantidade, gravada de uma vez pela `api`.
 *
 * A busca de SKU lê `skus` direto do navegador sob RLS, como a conferência de
 * documento (`../[id]/document-item-row.tsx`). O saldo da loja vem de
 * `inventory_balances` (LOCAL) e só AVISA: o ledger aceita saldo negativo, e
 * quem conta a prateleira sabe mais que o número.
 *
 * O identificador da saída nasce aqui e é a chave de idempotência na `api`:
 * reenviar a mesma saída (clique duplo, rede que caiu depois de gravar) não
 * baixa duas vezes. Qualquer mudança no formulário gera um identificador novo
 * — senão um reenvio com a quantidade corrigida seria ignorado em silêncio.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const ESPERA_MS = 200;

interface SkuResult {
  id: string;
  sku: string;
  title: string | null;
}

interface Linha {
  sku: SkuResult;
  quantidade: string;
  /** `undefined` = ainda lendo; `null` = não foi possível ler. */
  disponivel: number | null | undefined;
}

interface Resultado {
  itens: number;
  unidades: number;
  tipo: string;
}

function novoId(): string {
  return crypto.randomUUID();
}

async function lerSaldos(ids: string[]): Promise<Map<string, number> | null> {
  if (ids.length === 0) return new Map();

  try {
    const supabase = createClient();
    const respostas = await Promise.all(
      particionarEmLotes(ids, LOTE_CONSULTA_SAIDA).map((lote) =>
        supabase.from("inventory_balances").select("sku_id, quantity").eq("location_kind", "LOCAL").in("sku_id", lote),
      ),
    );

    // SKU sem linha no saldo tem zero na loja (o grão é SKU × local).
    const saldos = new Map<string, number>(ids.map((id) => [id, 0]));

    for (const { data, error } of respostas) {
      if (error !== null) return null;

      for (const linha of data) saldos.set(linha.sku_id, linha.quantity);
    }

    return saldos;
  } catch {
    return null;
  }
}

export function SaidaManualForm({ desabilitado }: { desabilitado: boolean }): ReactNode {
  const [tipo, setTipo] = useState<TipoDeSaida>("OUTROS");
  const [observacao, setObservacao] = useState("");
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [requestId, setRequestId] = useState<string>(novoId);

  const [busca, setBusca] = useState("");
  const [resultados, setResultados] = useState<SkuResult[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [erroBusca, setErroBusca] = useState<string | null>(null);
  const ultimaBusca = useRef(0);
  const campoBusca = useRef<HTMLInputElement>(null);

  const [importando, setImportando] = useState(false);
  const [listaColada, setListaColada] = useState("");
  const [lendoLista, setLendoLista] = useState(false);
  const [avisoImportacao, setAvisoImportacao] = useState<string | null>(null);

  const [emMassa, setEmMassa] = useState("");

  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  /** Toda mudança no que vai sair pede um identificador novo (ver o topo). */
  function mudou(): void {
    setRequestId(novoId());
    setErro(null);
  }

  useEffect(() => {
    const termo = busca.trim();
    const seguro = termoSeguroParaOr(termo);

    if (seguro.length < 2) {
      ultimaBusca.current += 1;
      setResultados([]);
      setBuscando(false);

      return;
    }

    const numero = ultimaBusca.current + 1;

    ultimaBusca.current = numero;
    setBuscando(true);

    const espera = setTimeout(() => {
      void (async () => {
        try {
          const { data, error } = await createClient()
            .from("skus")
            .select("id, sku, title")
            .or(`sku_key.ilike.%${seguro.toUpperCase()}%,title.ilike.%${seguro}%,barcode.ilike.%${seguro}%`)
            .order("sku")
            .limit(8);

          if (numero !== ultimaBusca.current) return;

          setBuscando(false);

          if (error !== null) {
            setErroBusca("Não foi possível buscar SKUs — tente de novo.");

            return;
          }

          setErroBusca(null);
          setResultados(data);
        } catch {
          if (numero !== ultimaBusca.current) return;

          setBuscando(false);
          setErroBusca("Não foi possível buscar SKUs — tente de novo.");
        }
      })();
    }, ESPERA_MS);

    return () => {
      clearTimeout(espera);
    };
  }, [busca]);

  /** Junta SKUs à lista: o que já está nela soma, o que é novo entra no fim. */
  async function adicionar(novos: { sku: SkuResult; quantidade: number }[]): Promise<number> {
    const presentes = new Set(linhas.map((linha) => linha.sku.id));
    const entram = novos.filter((novo) => !presentes.has(novo.sku.id));
    const cabem = Math.max(0, MAX_ITENS - linhas.length);
    const aceitos = entram.slice(0, cabem);
    const recusados = entram.length - aceitos.length;

    setLinhas((atuais) => {
      const porId = new Map(novos.map((novo) => [novo.sku.id, novo.quantidade]));
      const somadas = atuais.map((linha) => {
        const extra = porId.get(linha.sku.id);

        if (extra === undefined) return linha;

        const atual = quantidadeValida(linha.quantidade) ?? 0;

        return { ...linha, quantidade: String(somarQuantidadeNoLimite(atual, extra)) };
      });

      return [
        ...somadas,
        ...aceitos.map((novo) => ({ sku: novo.sku, quantidade: String(novo.quantidade), disponivel: undefined })),
      ];
    });
    mudou();

    const saldos = await lerSaldos(aceitos.map((novo) => novo.sku.id));

    setLinhas((atuais) =>
      atuais.map((linha) =>
        linha.disponivel === undefined && aceitos.some((novo) => novo.sku.id === linha.sku.id)
          ? { ...linha, disponivel: saldos === null ? null : (saldos.get(linha.sku.id) ?? 0) }
          : linha,
      ),
    );

    return recusados;
  }

  async function escolher(sku: SkuResult): Promise<void> {
    setBusca("");
    setResultados([]);

    const recusados = await adicionar([{ sku, quantidade: 1 }]);

    if (recusados > 0) setErro(`Uma saída leva até ${String(MAX_ITENS)} SKUs.`);

    campoBusca.current?.focus();
  }

  async function importarLista(): Promise<void> {
    const { linhas: lidas, invalidas } = lerListaDeSkus(listaColada);

    if (lidas.length === 0) {
      setAvisoImportacao(
        invalidas.length > 0
          ? `Nenhuma linha lida. Confira as linhas ${invalidas.join(", ")}: código do SKU e quantidade inteira.`
          : "Cole uma linha por SKU: o código e a quantidade.",
      );

      return;
    }

    setLendoLista(true);
    setAvisoImportacao(null);

    try {
      const linhasConsultadas = lidas.slice(0, MAX_CHAVES_IMPORTACAO);
      const excedentesDaLista = lidas.length - linhasConsultadas.length;
      const chaves = [...new Set(linhasConsultadas.map((linha) => chaveDoSku(linha.codigo)))];
      const supabase = createClient();
      const respostas = await Promise.all(
        particionarEmLotes(chaves, LOTE_CONSULTA_SAIDA).map((lote) =>
          supabase.from("skus").select("id, sku, title, sku_key").in("sku_key", lote),
        ),
      );

      const encontrados: { id: string; sku: string; title: string | null; sku_key: string }[] = [];

      for (const resposta of respostas) {
        if (resposta.error !== null) {
          setAvisoImportacao("Não foi possível conferir os SKUs da lista — tente de novo.");

          return;
        }

        encontrados.push(...resposta.data);
      }

      const porChave = new Map(encontrados.map((sku) => [sku.sku_key, sku]));
      const achados: { sku: SkuResult; quantidade: number }[] = [];
      const naoAchados: string[] = [];

      for (const linha of linhasConsultadas) {
        const sku = porChave.get(chaveDoSku(linha.codigo));

        if (sku === undefined) naoAchados.push(linha.codigo);
        else achados.push({ sku: { id: sku.id, sku: sku.sku, title: sku.title }, quantidade: linha.quantidade });
      }

      const recusados = (await adicionar(achados)) + excedentesDaLista;

      const avisos = [
        naoAchados.length > 0 &&
          `${String(naoAchados.length)} código${naoAchados.length === 1 ? "" : "s"} sem SKU no sistema: ${naoAchados.slice(0, 8).join(", ")}${naoAchados.length > 8 ? "…" : ""}.`,
        invalidas.length > 0 && `Linhas não lidas: ${invalidas.join(", ")}.`,
        recusados > 0 && `${String(recusados)} SKUs ficaram de fora: uma saída leva até ${String(MAX_ITENS)}.`,
      ].filter((aviso): aviso is string => typeof aviso === "string");

      setAvisoImportacao(
        avisos.length > 0 ? `${String(Math.max(0, achados.length - (recusados - excedentesDaLista)))} SKUs entraram. ${avisos.join(" ")}` : null,
      );

      if (avisos.length === 0) {
        setListaColada("");
        setImportando(false);
      }
    } catch {
      setAvisoImportacao("Não foi possível conferir os SKUs da lista — tente de novo.");
    } finally {
      setLendoLista(false);
    }
  }

  async function lerArquivo(arquivo: File): Promise<void> {
    try {
      setListaColada(await arquivo.text());
      setAvisoImportacao(null);
    } catch {
      setAvisoImportacao("Não foi possível ler o arquivo escolhido.");
    }
  }

  function mudarQuantidade(id: string, quantidade: string): void {
    setLinhas((atuais) => atuais.map((linha) => (linha.sku.id === id ? { ...linha, quantidade } : linha)));
    mudou();
  }

  function remover(id: string): void {
    setLinhas((atuais) => atuais.filter((linha) => linha.sku.id !== id));
    mudou();
  }

  function aplicarEmMassa(): void {
    if (quantidadeValida(emMassa) === null) return;

    setLinhas((atuais) => atuais.map((linha) => ({ ...linha, quantidade: emMassa.trim() })));
    setEmMassa("");
    mudou();
  }

  const quantidades = linhas.map((linha) => quantidadeValida(linha.quantidade));
  const todasValidas = linhas.length > 0 && quantidades.every((quantidade) => quantidade !== null);
  const unidades = quantidades.reduce<number>((soma, quantidade) => soma + (quantidade ?? 0), 0);
  const ficamNegativos = linhas.filter((linha, indice) => {
    const quantidade = quantidades[indice];

    return typeof linha.disponivel === "number" && quantidade !== null && quantidade !== undefined && quantidade > linha.disponivel;
  }).length;
  const pronto = !desabilitado && todasValidas && !enviando;

  async function darSaida(): Promise<void> {
    if (!pronto) return;

    setEnviando(true);
    setErro(null);

    const sessao = await lerTokenDeSessao("Sua sessão expirou. Entre de novo.");

    if (!sessao.ok) {
      setErro(sessao.mensagem);
      setEnviando(false);

      return;
    }

    let resposta: Response;

    try {
      resposta = await fetch(`${API_URL}/v1/stock/manual-exits`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessao.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          tipo,
          observacao: observacao.trim(),
          itens: linhas.map((linha, indice) => ({ skuId: linha.sku.id, quantidade: quantidades[indice] })),
        }),
      });
    } catch {
      // O identificador fica o mesmo: tentar de novo não duplica a saída.
      setErro("Não foi possível falar com o servidor. Tente de novo — a mesma saída não é gravada duas vezes.");
      setEnviando(false);

      return;
    }

    const payload: unknown = await resposta.json().catch(() => null);

    if (!resposta.ok || !respostaDeSaidaValida(payload, requestId)) {
      setErro(
        mensagemDaApi(payload) ??
          (resposta.ok
            ? "O servidor respondeu em formato inesperado. Confira em Movimentações ou tente de novo — a mesma saída não é gravada duas vezes."
            : "Não foi possível dar a saída."),
      );
      setEnviando(false);

      return;
    }

    setResultado({
      itens: linhas.length,
      unidades,
      tipo: TIPOS_DE_SAIDA.find((opcao) => opcao.valor === tipo)?.rotulo ?? tipo,
    });
    setLinhas([]);
    setObservacao("");
    setRequestId(novoId());
    setEnviando(false);
  }

  if (resultado !== null) {
    return (
      <section className="sb-panel sb-saida-feita" role="status">
        <span className="sb-eyebrow">SAÍDA REGISTRADA</span>
        <h2>
          {formatCount(resultado.unidades)} unidade{resultado.unidades === 1 ? "" : "s"} saíram do estoque da loja
        </h2>
        <p>
          {formatCount(resultado.itens)} SKU{resultado.itens === 1 ? "" : "s"} · {resultado.tipo}. Cada linha está nas
          movimentações como ajuste manual, com o seu nome e a observação.
        </p>
        <div className="sb-saida-feita-acoes">
          <button
            className="sb-button sb-button-primary"
            type="button"
            onClick={() => {
              setResultado(null);
              setTipo("OUTROS");
            }}
          >
            Nova saída
          </button>
          <Link className="sb-button" href="/estoque/movimentacoes">
            Ver movimentações
          </Link>
        </div>
      </section>
    );
  }

  const termo = busca.trim();

  return (
    <div className="sb-saida">
      <section className="sb-panel sb-saida-bloco" aria-labelledby="saida-info">
        <h2 id="saida-info" className="sb-saida-titulo">
          Info. da saída
        </h2>

        <div className="sb-saida-campos">
          <label className="sb-saida-campo">
            <span>
              Armazém <em aria-hidden="true">*</em>
            </span>
            {/* Um armazém só: a saída manual baixa da loja. O Full é do Mercado
                Livre, e a venda do Full já baixa por lá (D-352). */}
            <select className="sb-input sb-input-full" value="LOCAL" disabled aria-describedby="saida-armazem-nota">
              <option value="LOCAL">Estoque da loja</option>
            </select>
            <small id="saida-armazem-nota">O Full é baixado pelas vendas do Mercado Livre.</small>
          </label>

          <label className="sb-saida-campo">
            <span>
              Tipo de saída <em aria-hidden="true">*</em>
            </span>
            <select
              className="sb-input sb-input-full"
              value={tipo}
              onChange={(event) => {
                setTipo(event.target.value as TipoDeSaida);
                mudou();
              }}
              disabled={desabilitado || enviando}
            >
              {TIPOS_DE_SAIDA.map((opcao) => (
                <option key={opcao.valor} value={opcao.valor}>
                  {opcao.rotulo}
                </option>
              ))}
            </select>
          </label>

          <label className="sb-saida-campo sb-saida-campo-largo">
            <span>Observações</span>
            <textarea
              className="sb-input sb-input-full"
              rows={3}
              maxLength={OBSERVACAO_MAX}
              value={observacao}
              onChange={(event) => {
                setObservacao(event.target.value);
                mudou();
              }}
              placeholder="Ex.: caixa danificada no depósito, transferência para a filial…"
              disabled={desabilitado || enviando}
            />
            <small className="sb-saida-contador">
              {observacao.length}/{OBSERVACAO_MAX}
            </small>
          </label>
        </div>
      </section>

      <section className="sb-panel sb-saida-bloco" aria-labelledby="saida-produtos">
        <header className="sb-saida-cabeca">
          <h2 id="saida-produtos" className="sb-saida-titulo">
            Info. do produto
          </h2>
          <div className="sb-saida-cabeca-acoes">
            <Link className="sb-button sb-button-sm" href="/notas-fiscais/nova">
              Importar arquivo Full
            </Link>
            <button
              className="sb-button sb-button-sm"
              type="button"
              aria-expanded={importando}
              onClick={() => {
                setImportando((aberto) => !aberto);
                setAvisoImportacao(null);
              }}
              disabled={desabilitado || enviando}
            >
              Importar SKU
            </button>
            <button
              className="sb-button sb-button-sm sb-button-primary"
              type="button"
              onClick={() => {
                campoBusca.current?.focus();
              }}
              disabled={desabilitado || enviando}
            >
              Adicionar SKU
            </button>
          </div>
        </header>

        <div className="sb-nf-busca sb-saida-busca">
          <div className="sb-nf-busca-campo">
            <input
              ref={campoBusca}
              className="sb-input sb-input-full"
              type="search"
              value={busca}
              onChange={(event) => {
                setBusca(event.target.value);
              }}
              placeholder="SKU, código de barras ou nome do produto"
              aria-label="Buscar SKU para adicionar à saída"
              autoComplete="off"
              disabled={desabilitado || enviando}
            />

            {termo.length >= 2 && (
              <div className="sb-nf-busca-lista">
                {buscando && resultados.length === 0 && <p className="sb-nf-busca-vazio">Buscando…</p>}

                {!buscando && resultados.length === 0 && erroBusca === null && (
                  <p className="sb-nf-busca-vazio">Nenhum SKU com “{termo}”.</p>
                )}

                {resultados.length > 0 && (
                  <ul>
                    {resultados.map((sku) => (
                      <li key={sku.id}>
                        <button
                          className="sb-button"
                          type="button"
                          onClick={() => {
                            void escolher(sku);
                          }}
                        >
                          <b className="sb-mono">{sku.sku}</b>
                          {sku.title !== null && <span>{sku.title}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {erroBusca !== null && (
            <p role="alert" className="sb-nf-busca-erro">
              {erroBusca}
            </p>
          )}
        </div>

        {importando && (
          <div className="sb-saida-importar">
            <label className="sb-saida-campo sb-saida-campo-largo">
              <span>Uma linha por SKU: o código e a quantidade</span>
              <textarea
                className="sb-input sb-input-full sb-mono"
                rows={5}
                value={listaColada}
                onChange={(event) => {
                  setListaColada(event.target.value);
                }}
                placeholder={"PN-700X23C;4\nCAM-29-AV 2"}
                disabled={lendoLista}
              />
              <small>Cole da planilha ou escolha um arquivo .csv/.txt. O mesmo SKU em duas linhas soma.</small>
            </label>
            <div className="sb-saida-importar-acoes">
              <label className="sb-button sb-button-sm sb-saida-arquivo">
                Escolher arquivo
                <input
                  className="sb-input sb-sr-only"
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  onChange={(event) => {
                    const arquivo = event.target.files?.[0];

                    if (arquivo !== undefined) void lerArquivo(arquivo);

                    event.target.value = "";
                  }}
                />
              </label>
              <button
                className="sb-button sb-button-sm sb-button-primary"
                type="button"
                onClick={() => {
                  void importarLista();
                }}
                disabled={lendoLista || listaColada.trim() === ""}
              >
                {lendoLista ? "Conferindo…" : "Adicionar à saída"}
              </button>
            </div>
            {avisoImportacao !== null && (
              <p role="status" className="sb-nf-aviso sb-nf-aviso-atencao">
                {avisoImportacao}
              </p>
            )}
          </div>
        )}

        {linhas.length === 0 ? (
          <p className="sb-empty sb-saida-vazio">
            Nenhum SKU na saída. Busque acima ou importe uma lista — cada SKU entra com quantidade 1.
          </p>
        ) : (
          <div className="sb-nf-itens-rolagem">
            <table className="sb-table sb-saida-tabela">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th className="sb-num">Disponível na loja</th>
                  <th className="sb-num">
                    <span className="sb-saida-massa">
                      Qtd
                      <input
                        className="sb-input sb-saida-qtd"
                        inputMode="numeric"
                        value={emMassa}
                        onChange={(event) => {
                          setEmMassa(event.target.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") aplicarEmMassa();
                        }}
                        placeholder="todas"
                        aria-label="Quantidade para todos os SKUs"
                        disabled={enviando}
                      />
                      <button
                        className="sb-text-button"
                        type="button"
                        onClick={aplicarEmMassa}
                        disabled={enviando || quantidadeValida(emMassa) === null}
                      >
                        Editar em massa
                      </button>
                    </span>
                  </th>
                  <th>
                    <span className="sb-sr-only">Ação</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((linha, indice) => {
                  const quantidade = quantidades[indice] ?? null;
                  const falta =
                    typeof linha.disponivel === "number" && quantidade !== null && quantidade > linha.disponivel;

                  return (
                    <tr key={linha.sku.id}>
                      <td>
                        <span className="sb-nf-sku">
                          <b className="sb-mono">{linha.sku.sku}</b>
                          {linha.sku.title !== null && <span title={linha.sku.title}>{linha.sku.title}</span>}
                        </span>
                      </td>
                      <td className="sb-num">
                        {linha.disponivel === undefined ? (
                          <span className="sb-rep-mudo">…</span>
                        ) : linha.disponivel === null ? (
                          <span className="sb-rep-mudo" title="Não foi possível ler o saldo">
                            —
                          </span>
                        ) : (
                          <span className={falta ? "sb-nf-disponivel-falta" : undefined}>
                            {formatCount(linha.disponivel)}
                          </span>
                        )}
                      </td>
                      <td className="sb-num">
                        <input
                          className={quantidade === null ? "sb-input sb-saida-qtd sb-saida-qtd-invalida" : "sb-input sb-saida-qtd"}
                          inputMode="numeric"
                          value={linha.quantidade}
                          onChange={(event) => {
                            mudarQuantidade(linha.sku.id, event.target.value);
                          }}
                          aria-label={`Quantidade de ${linha.sku.sku}`}
                          aria-invalid={quantidade === null}
                          disabled={enviando}
                        />
                      </td>
                      <td>
                        <button
                          className="sb-text-button sb-saida-remover"
                          type="button"
                          onClick={() => {
                            remover(linha.sku.id);
                          }}
                          disabled={enviando}
                          aria-label={`Remover ${linha.sku.sku} da saída`}
                        >
                          Remover
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className={pronto ? "sb-nf-confirmar sb-nf-confirmar-pronto" : "sb-nf-confirmar"}>
        <div className="sb-nf-confirmar-texto">
          {linhas.length === 0 ? (
            <>
              <b>Nenhum SKU ainda</b>
              <span>Adicione os SKUs que saem e a quantidade de cada um.</span>
            </>
          ) : (
            <>
              <b>
                {formatCount(linhas.length)} SKU{linhas.length === 1 ? "" : "s"} ·{" "}
                {todasValidas
                  ? `${formatCount(unidades)} unidade${unidades === 1 ? "" : "s"} saem do estoque da loja`
                  : "confira as quantidades em vermelho"}
              </b>
              <span>
                {ficamNegativos > 0
                  ? `${String(ficamNegativos)} SKU${ficamNegativos === 1 ? " fica" : "s ficam"} com saldo negativo na loja. A saída é gravada mesmo assim.`
                  : "A baixa é imediata e fica nas movimentações com o seu nome."}
              </span>
            </>
          )}
          {erro !== null && (
            <p role="alert" className="sb-nf-confirmar-erro">
              {erro}
            </p>
          )}
        </div>

        <div className="sb-saida-rodape-acoes">
          <Link className="sb-button" href="/notas-fiscais">
            Cancelar
          </Link>
          <button
            className="sb-button sb-button-primary"
            type="button"
            onClick={() => {
              void darSaida();
            }}
            disabled={!pronto}
          >
            {enviando ? "Dando saída…" : "Dar saída"}
          </button>
        </div>
      </div>
    </div>
  );
}
