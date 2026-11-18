"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { formatCount } from "../../../../../lib/format";
import { LOGISTICS_STAGE } from "../../../../../lib/labels";
import {
  buscarSkus,
  corrigirLinhasImportacao,
  registrarReferenciaImportada,
  type CandidatoDuplicidade,
  type ResultadoRegistro,
} from "../../pedidos-ja-feitos-actions";

/**
 * A conferência do lote (D-764). Cada correção vai ao banco na hora
 * (`resolve_purchase_import_rows`), com o antes e o depois no histórico; a
 * gravação de uma referência vai por `commit_purchase_import_group`, que
 * passa pelo mesmo registro do "já fiz o pedido" (D-761).
 */

export interface Candidato {
  skuId: string;
  sku: string;
  title: string | null;
  kit: boolean;
  via: string[];
}

export interface LinhaLote {
  id: string;
  sheet: string;
  row: number;
  column: string;
  code: string | null;
  ean: string | null;
  ncm: string | null;
  description: string | null;
  quantityRaw: string;
  sourceReference: string | null;
  notes: string | null;
  quantity: number | null;
  quantityConfirmed: boolean;
  externalReference: string | null;
  referencia: string | null;
  matchStatus: "EXATA" | "PROVAVEL" | "AMBIGUA" | "NAO_ENCONTRADA";
  candidates: Candidato[];
  skuId: string | null;
  sku: string | null;
  skuTitle: string | null;
  resolution: "PENDENTE" | "VINCULADA" | "IGNORADA" | "REGISTRADA";
  purchaseOrderId: string | null;
  skuRepetido: boolean;
}

export interface GrupoLote {
  referencia: string | null;
  referenciaKey: string | null;
  linhas: number;
  vinculadas: number;
  pendentes: number;
  registradas: number;
  quantidadeAConfirmar: number;
  skuRepetido: number;
  unidades: number;
  abas: string[];
  pedidoExistente: { id: string; orderNumber: number; status: string; origin: string } | null;
  pedidoRegistrado: { id: string; orderNumber: number; status: string } | null;
}

const VINCULO: Record<LinhaLote["matchStatus"], string> = {
  EXATA: "exata",
  PROVAVEL: "provável",
  AMBIGUA: "ambígua",
  NAO_ENCONTRADA: "não encontrada",
};

const VIA: Record<string, string> = {
  CODIGO: "código",
  CODIGO_SEM_PONTUACAO: "código sem pontuação",
  CODIGO_FORNECEDOR: "código do fornecedor",
  EAN: "EAN",
};

export function LinhaConferencia({ loteId, linha }: { loteId: string; linha: LinhaLote }): ReactNode {
  const router = useRouter();
  const [skuId, setSkuId] = useState(linha.skuId ?? "");
  const [skuRotulo, setSkuRotulo] = useState(linha.sku);
  const [quantidade, setQuantidade] = useState(linha.quantity === null ? "" : String(linha.quantity));
  const [confirmada, setConfirmada] = useState(linha.quantityConfirmed);
  const [referencia, setReferencia] = useState(linha.externalReference ?? linha.sourceReference ?? "");
  const [busca, setBusca] = useState("");
  const [achados, setAchados] = useState<{ id: string; sku: string; title: string | null; kind: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const fechada = linha.resolution === "REGISTRADA";

  async function salvar(resolution?: "IGNORADA" | "PENDENTE"): Promise<void> {
    setBusy(true);
    setErro(null);

    const q = Number(quantidade.replace(/\./g, "").replace(",", "."));
    const r = await corrigirLinhasImportacao(loteId, [
      {
        rowId: linha.id,
        skuId: resolution === "PENDENTE" ? null : skuId === "" ? null : skuId,
        quantity: quantidade.trim() === "" || !Number.isFinite(q) ? null : q,
        quantityConfirmed: confirmada && quantidade.trim() !== "",
        externalReference: referencia.trim() === "" ? null : referencia.trim(),
        ...(resolution === undefined ? {} : { resolution }),
      },
    ]);

    setBusy(false);

    if (!r.ok) {
      setErro(r.message);

      return;
    }

    router.refresh();
  }

  async function procurar(): Promise<void> {
    setAchados(await buscarSkus(busca));
  }

  return (
    <tr className={`sb-imp-linha sb-imp-${linha.resolution.toLowerCase()}`}>
      <td className="sb-mono">
        {linha.sheet} · {linha.row} · {linha.column}
      </td>
      <td>
        <b className="sb-mono">{linha.code ?? "—"}</b>
        {linha.ean !== null && <small> EAN {linha.ean}</small>}
        <span className="sb-rep-titulo">{linha.description ?? "sem descrição"}</span>
        {linha.notes !== null && <small className="sb-imp-obs">obs.: {linha.notes}</small>}
      </td>
      <td>
        <span className={`sb-imp-vinculo sb-imp-vinculo-${linha.matchStatus.toLowerCase()}`}>{VINCULO[linha.matchStatus]}</span>
        {fechada ? (
          <span>
            {linha.sku}{" "}
            {linha.purchaseOrderId !== null && <Link href={`/compras/${linha.purchaseOrderId}`}>ver pedido</Link>}
          </span>
        ) : (
          <>
            <select
              className="sb-input sb-input-sm"
              value={skuId}
              aria-label={`SKU da linha ${String(linha.row)}`}
              onChange={(e) => {
                setSkuId(e.target.value);
                setSkuRotulo(null);
              }}
            >
              <option value="">— escolher —</option>
              {linha.skuId !== null && !linha.candidates.some((c) => c.skuId === linha.skuId) && (
                <option value={linha.skuId}>{linha.sku}</option>
              )}
              {linha.candidates.map((c) => (
                <option key={c.skuId} value={c.skuId}>
                  {c.sku}
                  {c.kit ? " (kit)" : ""} · {c.via.map((v) => VIA[v] ?? v).join(", ")}
                </option>
              ))}
              {achados
                .filter((a) => !linha.candidates.some((c) => c.skuId === a.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.sku}
                    {a.kind === "KIT" ? " (kit)" : ""} · busca
                  </option>
                ))}
            </select>
            {skuRotulo !== null && linha.skuTitle !== null && <small>{linha.skuTitle}</small>}
            <span className="sb-imp-busca">
              <input
                className="sb-input sb-input-sm"
                value={busca}
                placeholder="buscar SKU"
                aria-label="Buscar SKU no catálogo"
                onChange={(e) => { setBusca(e.target.value); }}
              />
              <button type="button" className="sb-button sb-button-sm" onClick={() => void procurar()} disabled={busca.trim().length < 2}>
                Buscar
              </button>
            </span>
          </>
        )}
      </td>
      <td>
        <small className="sb-mono">planilha: {linha.quantityRaw}</small>
        {!fechada && (
          <>
            <input
              className="sb-input sb-input-sm"
              inputMode="decimal"
              value={quantidade}
              aria-label={`Quantidade da linha ${String(linha.row)}`}
              onChange={(e) => { setQuantidade(e.target.value); }}
            />
            <label className="sb-imp-confirma">
              <input type="checkbox" checked={confirmada} onChange={(e) => { setConfirmada(e.target.checked); }} /> confirmada
            </label>
          </>
        )}
        {fechada && <span>{formatCount(linha.quantity)}</span>}
      </td>
      <td>
        {fechada ? (
          linha.referencia
        ) : (
          <input
            className="sb-input sb-input-sm"
            value={referencia}
            maxLength={80}
            placeholder="informar"
            aria-label={`Referência do pedido da linha ${String(linha.row)}`}
            onChange={(e) => { setReferencia(e.target.value); }}
          />
        )}
        {linha.skuRepetido && <small className="sb-pjf-erro">SKU repetido nesta referência</small>}
      </td>
      <td>
        {!fechada && (
          <span className="sb-imp-acoes">
            <button type="button" className="sb-button sb-button-sm sb-button-primary" disabled={busy} onClick={() => void salvar()}>
              {skuId === "" ? "Salvar" : "Vincular"}
            </button>
            {linha.resolution !== "IGNORADA" ? (
              <button type="button" className="sb-button sb-button-sm" disabled={busy} onClick={() => void salvar("IGNORADA")}>
                Ignorar
              </button>
            ) : (
              <button type="button" className="sb-button sb-button-sm" disabled={busy} onClick={() => void salvar("PENDENTE")}>
                Reabrir
              </button>
            )}
          </span>
        )}
        {erro !== null && (
          <small className="sb-pjf-erro" role="alert">
            {erro}
          </small>
        )}
      </td>
    </tr>
  );
}

const ETAPAS = ["EM_PRODUCAO", "PRONTO_EMBARQUE", "EMBARCADO", "EM_TRANSITO", "DESEMBARACO", "TRANSPORTE_NACIONAL"];

export function GrupoRegistro({
  loteId,
  grupo,
  fornecedores,
}: {
  loteId: string;
  grupo: GrupoLote;
  fornecedores: readonly { id: string; name: string }[];
}): ReactNode {
  const router = useRouter();
  const [situacao, setSituacao] = useState<"" | "PLANEJADO" | "PEDIDO_REALIZADO">("");
  const [fornecedorId, setFornecedorId] = useState("");
  const [previsao, setPrevisao] = useState("");
  const [dataPedido, setDataPedido] = useState("");
  const [etapa, setEtapa] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [candidatos, setCandidatos] = useState<CandidatoDuplicidade[] | null>(null);

  const bloqueio =
    grupo.referencia === null
      ? "Informe a referência nas linhas desta coluna para registrar."
      : grupo.vinculadas === 0
        ? grupo.registradas > 0
          ? null
          : "Nenhuma linha vinculada a um SKU ainda."
        : grupo.quantidadeAConfirmar > 0
          ? `Confirme ${formatCount(grupo.quantidadeAConfirmar)} quantidade(s) antes de registrar.`
          : grupo.skuRepetido > 0
            ? "O mesmo SKU aparece mais de uma vez nesta referência: ignore uma linha ou some as quantidades."
            : null;

  async function registrar(confirmarNovo: boolean, pedidoAlvoId: string | null): Promise<void> {
    if (grupo.referencia === null) return;
    if (situacao === "" && pedidoAlvoId === null) {
      setMsg({ ok: false, texto: "Escolha a situação: pedido realizado ou só planejado." });

      return;
    }

    setBusy(true);
    setMsg(null);

    const r: ResultadoRegistro = await registrarReferenciaImportada({
      loteId,
      referencia: grupo.referencia,
      situacao: situacao === "" ? "PLANEJADO" : situacao,
      fornecedorId: fornecedorId === "" ? null : fornecedorId,
      previsao: previsao === "" ? null : previsao,
      dataPedido: dataPedido === "" ? null : dataPedido,
      etapa: situacao === "PEDIDO_REALIZADO" && etapa !== "" ? etapa : null,
      confirmarNovo,
      pedidoAlvoId,
    });

    setBusy(false);

    if (!r.ok) {
      setMsg({ ok: false, texto: r.message ?? "Não foi possível registrar." });

      return;
    }

    if (r.resultado === "POSSIVEL_DUPLICIDADE" || r.resultado === "REFERENCIA_EXISTENTE") {
      setCandidatos(r.candidatos ?? []);
      setMsg({
        ok: false,
        texto:
          r.resultado === "REFERENCIA_EXISTENTE"
            ? "Já existe pedido com esta referência deste fornecedor. Acrescente os itens a ele ou corrija a referência."
            : "Há pedidos em aberto que podem ser esta mesma compra. Confira antes de registrar.",
      });

      return;
    }

    setCandidatos(null);
    setMsg({
      ok: true,
      texto:
        r.resultado === "NADA_A_REGISTRAR"
          ? "Nada novo a registrar nesta referência."
          : `Pedido nº ${String(r.pedido?.orderNumber ?? "")} ${r.resultado === "ACRESCENTADO" ? "atualizado" : "registrado"}.`,
    });
    router.refresh();
  }

  const externoExistente = grupo.pedidoExistente !== null && grupo.pedidoExistente.origin !== "INTERNO";

  return (
    <article className="sb-imp-grupo">
      <header>
        <b>{grupo.referencia ?? "Sem referência"}</b>
        <small>
          {formatCount(grupo.vinculadas)} vinculada(s) · {formatCount(grupo.unidades)} un · {formatCount(grupo.pendentes)} a conferir ·{" "}
          {grupo.abas.join(", ")}
        </small>
        {grupo.pedidoRegistrado !== null && (
          <Link href={`/compras/${grupo.pedidoRegistrado.id}`}>Pedido nº {grupo.pedidoRegistrado.orderNumber}</Link>
        )}
        {grupo.pedidoRegistrado === null && grupo.pedidoExistente !== null && (
          <span className="sb-pjf-aviso">
            Já existe o <Link href={`/compras/${grupo.pedidoExistente.id}`}>pedido nº {grupo.pedidoExistente.orderNumber}</Link> com esta referência
            {grupo.pedidoExistente.origin === "INTERNO" ? " (interno)" : ""}.
          </span>
        )}
      </header>

      {bloqueio !== null ? (
        <p className="sb-imp-nota">{bloqueio}</p>
      ) : grupo.vinculadas > 0 ? (
        <div className="sb-imp-registro">
          <fieldset className="sb-pjf-situacao">
            <legend>Situação *</legend>
            <label>
              <input type="radio" checked={situacao === "PEDIDO_REALIZADO"} onChange={() => { setSituacao("PEDIDO_REALIZADO"); }} /> Pedido realizado
            </label>
            <label>
              <input type="radio" checked={situacao === "PLANEJADO"} onChange={() => { setSituacao("PLANEJADO"); }} /> Só planejado
            </label>
          </fieldset>
          <select className="sb-input sb-input-sm" value={fornecedorId} aria-label="Fornecedor" onChange={(e) => { setFornecedorId(e.target.value); }}>
            <option value="">fornecedor não informado</option>
            {fornecedores.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <label className="sb-pjf-campo">
            <span>Data do pedido</span>
            <input className="sb-input sb-input-sm" type="date" value={dataPedido} onChange={(e) => { setDataPedido(e.target.value); }} />
          </label>
          <label className="sb-pjf-campo">
            <span>Previsão</span>
            <input className="sb-input sb-input-sm" type="date" value={previsao} onChange={(e) => { setPrevisao(e.target.value); }} />
          </label>
          {situacao === "PEDIDO_REALIZADO" && (
            <select className="sb-input sb-input-sm" value={etapa} aria-label="Situação logística" onChange={(e) => { setEtapa(e.target.value); }}>
              <option value="">pedido realizado</option>
              {ETAPAS.map((s) => (
                <option key={s} value={s}>
                  {LOGISTICS_STAGE[s] ?? s}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="sb-button sb-button-primary" disabled={busy} onClick={() => void registrar(false, null)}>
            {busy ? "Registrando…" : "Registrar pedido"}
          </button>
          {externoExistente && grupo.pedidoExistente !== null && (
            <button type="button" className="sb-button" disabled={busy} onClick={() => void registrar(false, grupo.pedidoExistente?.id ?? null)}>
              Acrescentar ao pedido nº {grupo.pedidoExistente.orderNumber}
            </button>
          )}
        </div>
      ) : null}

      {msg !== null && (
        <p className={msg.ok ? "sb-pjf-ok" : "sb-pjf-erro"} role={msg.ok ? "status" : "alert"}>
          {msg.texto}
        </p>
      )}

      {candidatos !== null && candidatos.length > 0 && (
        <div className="sb-pjf-candidatos">
          <ul>
            {candidatos.map((c) => (
              <li key={`${c.motivo}-${c.purchaseOrderId}-${c.sku ?? ""}`}>
                <Link href={`/compras/${c.purchaseOrderId}`} target="_blank">
                  Pedido nº {c.orderNumber}
                </Link>{" "}
                · {c.motivo === "MESMA_REFERENCIA" ? "mesma referência" : `${c.sku ?? ""} em aberto`}
                {c.externalReference !== null && ` · ref. ${c.externalReference}`}
                {c.pendente !== null && ` · ${formatCount(c.pendente)} un`}
              </li>
            ))}
          </ul>
          <p className="sb-imp-nota">
            Se for a mesma compra, vincule a referência na tela do pedido existente e ignore estas linhas. Se for outra
            compra, registre mesmo assim.
          </p>
          <button type="button" className="sb-button" disabled={busy} onClick={() => void registrar(true, null)}>
            É outra compra: registrar
          </button>
        </div>
      )}
    </article>
  );
}
