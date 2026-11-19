"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { formatCount } from "../../../../../lib/format";
import { LOGISTICS_STAGE } from "../../../../../lib/labels";
import {
  buscarSkus,
  corrigirLinhasImportacao,
  criarSkusDaImportacao,
  type ResultadoCriarSkus,
  registrarReferenciaImportada,
  type CandidatoDuplicidade,
  type ResultadoRegistro,
} from "../../pedidos-ja-feitos-actions";

/**
 * A conferência do lote (D-764). Cada correção vai ao banco na hora
 * (`resolve_purchase_import_rows`), com o antes e o depois no histórico; a
 * gravação de uma referência vai por `commit_purchase_import_group`, que
 * passa pelo mesmo registro do "já fiz o pedido" (D-761).
 *
 * Invoice (D-767): cada linha mostra preço e valor como estavam no documento;
 * o grupo mostra o total e já traz a data e a entrega da proforma e a etapa
 * "embarcado" quando a invoice tem B/L ou contêiner — tudo editável, e a
 * situação continua sendo escolha do usuário. O mesmo SKU em várias linhas é
 * somado; SKU que já está no pedido da referência é sinalizado, porque o
 * pedido não aceita o mesmo item duas vezes.
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
  /** D-767. Ausentes enquanto a migration da invoice não chegou ao banco. */
  unitPrice?: number | null;
  amount?: number | null;
  currency?: string | null;
  unit?: string | null;
  /** Quanto deste SKU já está no pedido que tem a referência. */
  jaNoPedido?: number | null;
}

export interface DocumentoLote {
  tipo?: "COMERCIAL" | "PROFORMA";
  numero?: string;
  data?: string;
  dataIso?: string;
  bl?: string;
  container?: string;
  entrega?: string;
  entregaIso?: string;
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
  jaNoPedido?: number;
  moeda?: string | null;
  valor?: number | null;
  documento?: DocumentoLote | null;
  pedidoExistente: { id: string; orderNumber: number; status: string; origin: string; currency?: string } | null;
  pedidoRegistrado: { id: string; orderNumber: number; status: string } | null;
}

const VINCULO: Record<LinhaLote["matchStatus"], string> = {
  EXATA: "exata",
  PROVAVEL: "provável",
  AMBIGUA: "ambígua",
  NAO_ENCONTRADA: "não encontrada",
};

export function formatarDinheiro(valor: number, moeda: string | null | undefined): string {
  const n = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(valor);

  return moeda === "USD" ? `US$ ${n}` : moeda === "BRL" ? `R$ ${n}` : moeda === null || moeda === undefined ? `${n} (moeda não informada)` : `${moeda} ${n}`;
}

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

  // D-792: o produto que ainda não existe nasce com o código e o nome da invoice.
  async function criarSku(): Promise<void> {
    setBusy(true);
    setErro(null);

    const r = await criarSkusDaImportacao(loteId, [linha.id]);

    setBusy(false);

    if (!r.ok) {
      setErro(r.message);

      return;
    }

    const parecido = r.parecidos?.[0];

    if (parecido !== undefined) {
      setErro(`Já existe ${parecido.parecido} no catálogo, parecido com ${parecido.code}: se for o mesmo produto, busque e vincule.`);
      setBusca(parecido.parecido.split(",")[0]?.trim() ?? "");

      return;
    }

    router.refresh();
  }

  const podeCriar = !fechada && linha.skuId === null && linha.resolution !== "IGNORADA" && (linha.code ?? "").trim() !== "";

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
            {podeCriar && (
              <button
                type="button"
                className="sb-button sb-button-sm"
                disabled={busy}
                title="Cria o produto no catálogo com o código, o nome e o NCM desta linha"
                onClick={() => void criarSku()}
              >
                Criar SKU {linha.code}
              </button>
            )}
          </>
        )}
      </td>
      <td>
        <small className="sb-mono">
          planilha: {linha.quantityRaw}
          {linha.unit !== null && linha.unit !== undefined && ` ${linha.unit}`}
        </small>
        {linha.unitPrice !== null && linha.unitPrice !== undefined && (
          <small className="sb-imp-preco">
            {formatarDinheiro(linha.unitPrice, linha.currency)}/un
            {linha.amount !== null && linha.amount !== undefined && ` · ${formatarDinheiro(linha.amount, linha.currency)}`}
          </small>
        )}
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
        {linha.skuRepetido && <small className="sb-imp-obs">mesmo SKU em outra linha: as quantidades são somadas</small>}
        {linha.jaNoPedido !== null && linha.jaNoPedido !== undefined && !fechada && (
          <small className="sb-pjf-erro">
            já está no pedido desta referência com {formatCount(linha.jaNoPedido)} un — se for o mesmo item, ignore a linha
          </small>
        )}
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

/**
 * D-792: cria de uma vez o SKU de todas as linhas NÃO ENCONTRADAS do lote, com
 * o código e o nome da invoice. Código parecido com um do catálogo (KC30 ×
 * KC0030) não é criado: volta na lista para o usuário vincular pela busca.
 */
export function CriarSkusDoLote({ loteId, naoEncontradas }: { loteId: string; naoEncontradas: number }): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState<ResultadoCriarSkus | null>(null);

  if (naoEncontradas === 0 && resultado === null) return null;

  async function criar(): Promise<void> {
    setBusy(true);

    const r = await criarSkusDaImportacao(loteId, []);

    setBusy(false);
    setResultado(r);
    if (r.ok) router.refresh();
  }

  const parecidos = resultado?.parecidos ?? [];

  return (
    <div className="sb-imp-criar-skus">
      {naoEncontradas > 0 && (
        <p>
          <b>{formatCount(naoEncontradas)} linha(s) com produto que não existe no catálogo.</b> Crie o SKU com o código e o nome
          que a invoice trouxe, ou vincule cada uma a um SKU existente na tabela abaixo.{" "}
          <button type="button" className="sb-button sb-button-sm sb-button-primary" disabled={busy} onClick={() => void criar()}>
            {busy ? "Criando…" : `Criar SKU das ${formatCount(naoEncontradas)} não encontradas`}
          </button>
        </p>
      )}
      {resultado !== null && !resultado.ok && (
        <p className="sb-pjf-erro" role="alert">
          {resultado.message}
        </p>
      )}
      {resultado?.ok === true && (
        <p role="status">
          {formatCount(resultado.criados ?? 0)} SKU(s) criados e {formatCount(resultado.vinculados ?? 0)} linha(s) vinculadas.
          {(resultado.semCodigo ?? 0) > 0 && ` ${formatCount(resultado.semCodigo ?? 0)} linha(s) sem código ficaram para vincular à mão.`}
        </p>
      )}
      {parecidos.length > 0 && (
        <div className="sb-pjf-erro" role="alert">
          {formatCount(parecidos.length)} código(s) parecidos com um SKU do catálogo não foram criados — se for o mesmo produto,
          vincule pela busca na linha:
          <ul>
            {parecidos.map((p) => (
              <li key={p.rowId}>
                <span className="sb-mono">{p.code}</span> → já existe <span className="sb-mono">{p.parecido}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
  const doc = grupo.documento ?? null;
  const embarcada = doc !== null && (doc.bl !== undefined || doc.container !== undefined);
  const datasDoDocumento = doc !== null && (doc.entregaIso !== undefined || (doc.tipo === "PROFORMA" && doc.dataIso !== undefined));
  const [situacao, setSituacao] = useState<"" | "PLANEJADO" | "PEDIDO_REALIZADO">("");
  const [fornecedorId, setFornecedorId] = useState("");
  // Do documento, editável: a entrega que a proforma promete e a data dela (a da invoice comercial é a do embarque).
  const [previsao, setPrevisao] = useState(doc?.entregaIso ?? "");
  const [dataPedido, setDataPedido] = useState(doc?.tipo === "PROFORMA" ? (doc.dataIso ?? "") : "");
  const [etapa, setEtapa] = useState(embarcada ? "EMBARCADO" : "");
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
          {grupo.valor !== null && grupo.valor !== undefined && ` · ${formatarDinheiro(grupo.valor, grupo.moeda)} na invoice`}
        </small>
        {doc !== null && (
          <small className="sb-imp-obs">
            {[
              doc.numero === undefined ? null : `${doc.tipo === "PROFORMA" ? "Proforma" : "Invoice"} ${doc.numero}`,
              doc.data === undefined ? null : `de ${doc.data}`,
              doc.bl === undefined ? null : `B/L ${doc.bl}`,
              doc.container === undefined ? null : `contêiner ${doc.container}`,
              doc.entrega === undefined ? null : `entrega prevista ${doc.entrega}`,
            ]
              .filter((t) => t !== null)
              .join(" · ")}
          </small>
        )}
        {grupo.pedidoRegistrado !== null && (
          <Link href={`/compras/${grupo.pedidoRegistrado.id}`}>Pedido nº {grupo.pedidoRegistrado.orderNumber}</Link>
        )}
        {grupo.pedidoRegistrado === null && grupo.pedidoExistente !== null && (
          <span className="sb-pjf-aviso">
            Já existe o <Link href={`/compras/${grupo.pedidoExistente.id}`}>pedido nº {grupo.pedidoExistente.orderNumber}</Link> com esta referência
            {grupo.pedidoExistente.origin === "INTERNO" ? " (interno)" : ""}.
            {(grupo.jaNoPedido ?? 0) > 0 &&
              ` ${formatCount(grupo.jaNoPedido ?? 0)} linha(s) desta invoice são de SKUs que já estão nele: se for o mesmo item, ignore essas linhas; o pedido não aceita o mesmo SKU duas vezes.`}
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
          {(datasDoDocumento || embarcada) && (
            <small className="sb-imp-obs">
              {embarcada ? "A invoice tem B/L ou contêiner: a etapa sugerida é “Embarcado”. " : ""}
              {datasDoDocumento ? "As datas vieram do documento. " : ""}
              Confira antes de registrar.
            </small>
          )}
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
