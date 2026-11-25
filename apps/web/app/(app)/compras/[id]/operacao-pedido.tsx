"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";

import { formatCount, formatCurrency } from "../../../../lib/format";
import { LOGISTICS_STAGE, PURCHASE_COST_KIND, STAGES_BY_STATUS } from "../../../../lib/labels";
import {
  deletePurchaseOrderCost,
  receivePurchaseOrderItems,
  setPurchaseOrderStage,
  upsertPurchaseOrderCost,
} from "../actions";

/**
 * A operação do pedido depois de criado (D-724, D-725): receber o que chegou,
 * atualizar a etapa logística e lançar os custos de importação. Cada ação vai
 * por uma RPC que refaz a autorização e a regra de estado no banco; aqui só se
 * coleta a intenção e se mostra o erro em português.
 *
 * FALHA DE TRANSPORTE (D-865): a Server Action pode não responder. Sem o
 * `try`, o botão ficava em "Registrando…"/"Salvando…" para sempre. Agora a
 * tela avisa, libera o botão, mantém o que foi digitado e relê o pedido, para a
 * pessoa ver se a primeira tentativa chegou antes de repetir.
 */

/** Relê o pedido depois de uma falha de transporte, sem deixar a rejeição escapar. */
function reler(router: ReturnType<typeof useRouter>): void {
  try {
    router.refresh();
  } catch {
    // Sem rede, a releitura também falha; o aviso já está na tela.
  }
}

export interface ItemPendente {
  readonly id: string;
  readonly sku: string;
  readonly pedido: number;
  readonly recebido: number;
}

/** Recebimento parcial: só os pendentes, com a quantidade sugerida = o que falta. */
export function RecebimentoParcial({ purchaseOrderId, itens }: { purchaseOrderId: string; itens: readonly ItemPendente[] }): ReactNode {
  const router = useRouter();
  const pendentes = itens.filter((i) => i.recebido < i.pedido);
  const [quantidades, setQuantidades] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);
  // Uma requisição por envio: repetir depois de falha de rede não recebe duas vezes.
  const requestId = useRef<string | null>(null);

  if (pendentes.length === 0) return null;

  async function enviar(): Promise<void> {
    const itensEnvio = pendentes.flatMap((i) => {
      const q = Number((quantidades[i.id] ?? "").replace(",", "."));

      return Number.isFinite(q) && q > 0 ? [{ itemId: i.id, quantity: q }] : [];
    });

    if (itensEnvio.length === 0) {
      setErro("Informe ao menos uma quantidade recebida.");

      return;
    }

    setBusy(true);
    setErro(null);
    requestId.current ??= crypto.randomUUID();

    let r: Awaited<ReturnType<typeof receivePurchaseOrderItems>>;

    try {
      r = await receivePurchaseOrderItems(purchaseOrderId, itensEnvio, requestId.current);
    } catch {
      // O `requestId` fica o mesmo: se o recebimento chegou ao banco, a nova
      // tentativa é reconhecida e não dá entrada duas vezes (D-724).
      setErro(
        "Não foi possível confirmar o recebimento. Confira as quantidades já recebidas e tente de novo: o mesmo envio não é registrado duas vezes.",
      );
      setBusy(false);
      reler(router);

      return;
    }

    setBusy(false);

    if (!r.ok) {
      setErro(r.message);

      return;
    }

    requestId.current = null;
    setQuantidades({});
    setAberto(false);
    router.refresh();
  }

  return (
    <div className="sb-pod-operacao">
      {!aberto ? (
        <button
          type="button"
          className="sb-button"
          onClick={() => {
            setAberto(true);
          }}
        >
          Receber parte do pedido
        </button>
      ) : (
        <form
          className="sb-pod-receber"
          onSubmit={(e) => {
            e.preventDefault();
            void enviar();
          }}
        >
          <p className="sb-pod-receber-ajuda">
            Informe o que chegou de cada item. Essa quantidade sai do trânsito e entra no estoque local; o pedido fica
            em aberto até chegar tudo. A conciliação com o UpSeller continua acertando o saldo pelo ERP.
          </p>
          <table className="sb-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th className="sb-num">Pedido</th>
                <th className="sb-num">Já recebido</th>
                <th className="sb-num">Chegou agora</th>
              </tr>
            </thead>
            <tbody>
              {pendentes.map((i) => (
                <tr key={i.id}>
                  <td className="sb-mono">{i.sku}</td>
                  <td className="sb-num">{formatCount(i.pedido)}</td>
                  <td className="sb-num">{formatCount(i.recebido)}</td>
                  <td className="sb-num">
                    <input
                      className="sb-input sb-pod-qtd"
                      inputMode="decimal"
                      aria-label={`Quantidade recebida agora de ${i.sku}`}
                      placeholder={`até ${formatCount(i.pedido - i.recebido)}`}
                      value={quantidades[i.id] ?? ""}
                      onChange={(e) => {
                        setQuantidades((atual) => ({ ...atual, [i.id]: e.target.value }));
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {erro !== null && (
            <p role="alert" className="sb-note sb-note-perigo">
              {erro}
            </p>
          )}
          <div className="sb-pod-receber-acoes">
            <button
              type="button"
              className="sb-button"
              onClick={() => {
                setQuantidades(Object.fromEntries(pendentes.map((i) => [i.id, String(i.pedido - i.recebido)])));
              }}
            >
              Preencher com o que falta
            </button>
            <button type="submit" className="sb-button sb-button-primary" disabled={busy}>
              {busy ? "Registrando…" : "Registrar recebimento"}
            </button>
            <button
              type="button"
              className="sb-button"
              onClick={() => {
                setAberto(false);
                setErro(null);
              }}
            >
              Fechar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** A etapa logística: as opções são as que o banco aceita para o status atual. */
export function EtapaLogistica({
  purchaseOrderId,
  status,
  etapa,
}: {
  purchaseOrderId: string;
  status: string;
  etapa: string | null;
}): ReactNode {
  const router = useRouter();
  const opcoes = STAGES_BY_STATUS[status] ?? [];
  const [valor, setValor] = useState(etapa ?? "");
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  if (opcoes.length === 0) return null;

  return (
    <form
      className="sb-pod-etapa"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setErro(null);
        void setPurchaseOrderStage(purchaseOrderId, valor === "" ? null : valor, null).then(
          (r) => {
            setBusy(false);

            if (!r.ok) setErro(r.message);
            else router.refresh();
          },
          () => {
            // Repetir a mesma etapa é inofensivo: a nova tentativa só grava de novo o mesmo valor.
            setBusy(false);
            setErro("Não foi possível confirmar a etapa. Tente de novo.");
            reler(router);
          },
        );
      }}
    >
      <label className="sb-form-campo">
        <span>Etapa logística</span>
        <select
          className="sb-input"
          value={valor}
          onChange={(e) => {
            setValor(e.target.value);
          }}
        >
          <option value="">Sem etapa</option>
          {opcoes.map((o) => (
            <option key={o} value={o}>
              {LOGISTICS_STAGE[o] ?? o}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="sb-button" disabled={busy || valor === (etapa ?? "")}>
        {busy ? "Salvando…" : "Atualizar etapa"}
      </button>
      {erro !== null && (
        <p role="alert" className="sb-note sb-note-perigo">
          {erro}
        </p>
      )}
    </form>
  );
}

export interface CustoLinha {
  readonly id: string;
  readonly kind: string;
  readonly description: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly exchangeRate: number | null;
  readonly status: string;
}

/*
  O aviso de falha de transporte dos custos precisa sobreviver à releitura que
  ele mesmo pede. Sem nenhum custo, a página mostra a seção num `<details>`;
  quando a primeira inclusão grava (ou a exclusão do último custo apaga), a
  releitura troca de ramo e monta OUTRO `CustosDoPedido`, e o estado local se
  perde com o aviso. Por isso o aviso fica guardado por pedido, só enquanto é
  recente, e o componente novo começa com ele.
*/
const AVISO_DE_CUSTO_VALIDO_MS = 60_000;
const avisosDeCusto = new Map<string, { texto: string; em: number }>();

function avisoDeCustoRecente(purchaseOrderId: string): string | null {
  const aviso = avisosDeCusto.get(purchaseOrderId);

  if (aviso === undefined) return null;

  if (Date.now() - aviso.em > AVISO_DE_CUSTO_VALIDO_MS) {
    avisosDeCusto.delete(purchaseOrderId);

    return null;
  }

  return aviso.texto;
}

/*
  A requisição da inclusão (D-869) também precisa sobreviver à troca de ramo:
  se a primeira tentativa gravou e a resposta se perdeu, quem repete com os
  MESMOS dados no formulário novo tem de mandar a mesma requisição, e o banco
  devolve o custo já lançado. Dados diferentes geram outra requisição. A
  pendência some quando a inclusão é confirmada, e vale por 10 minutos.
*/
const REQUISICAO_DE_CUSTO_VALIDA_MS = 600_000;
const requisicoesDeCusto = new Map<string, { chave: string; id: string; em: number }>();

function requisicaoDeCusto(purchaseOrderId: string, chave: string): string {
  const pendente = requisicoesDeCusto.get(purchaseOrderId);

  if (pendente?.chave === chave && Date.now() - pendente.em <= REQUISICAO_DE_CUSTO_VALIDA_MS) {
    return pendente.id;
  }

  const id = crypto.randomUUID();

  requisicoesDeCusto.set(purchaseOrderId, { chave, id, em: Date.now() });

  return id;
}

/** Os custos adicionais do pedido: listar, incluir e excluir. */
export function CustosDoPedido({
  purchaseOrderId,
  custos,
  podeEditar,
}: {
  purchaseOrderId: string;
  custos: readonly CustoLinha[];
  podeEditar: boolean;
}): ReactNode {
  const router = useRouter();
  const [kind, setKind] = useState("FRETE_INTERNACIONAL");
  const [valor, setValor] = useState("");
  const [moeda, setMoeda] = useState("BRL");
  const [cambio, setCambio] = useState("");
  const [status, setStatus] = useState<"ESTIMADO" | "REALIZADO">("ESTIMADO");
  const [descricao, setDescricao] = useState("");
  const [busy, setBusy] = useState(false);
  const [erro, setErroLocal] = useState<string | null>(() => avisoDeCustoRecente(purchaseOrderId));

  function setErro(texto: string | null): void {
    avisosDeCusto.delete(purchaseOrderId);
    setErroLocal(texto);
  }

  /** Falha de transporte: o aviso segue para o componente que a releitura montar. */
  function avisarFalhaDeTransporte(texto: string): void {
    avisosDeCusto.set(purchaseOrderId, { texto, em: Date.now() });
    setErroLocal(texto);
  }

  async function incluir(): Promise<void> {
    const amount = Number(valor.replace(",", "."));
    const rate = cambio.trim() === "" ? null : Number(cambio.replace(",", "."));

    if (!Number.isFinite(amount) || amount < 0 || (rate !== null && (!Number.isFinite(rate) || rate <= 0))) {
      setErro("Valor e câmbio precisam ser números positivos.");

      return;
    }

    setBusy(true);
    setErro(null);

    const input = {
      id: null,
      kind,
      description: descricao.trim() === "" ? null : descricao.trim(),
      amount,
      currency: moeda.trim().toUpperCase() || "BRL",
      exchangeRate: moeda.trim().toUpperCase() === "BRL" ? null : rate,
      status,
    };
    const requestId = requisicaoDeCusto(purchaseOrderId, JSON.stringify(input));
    let r: Awaited<ReturnType<typeof upsertPurchaseOrderCost>>;

    try {
      r = await upsertPurchaseOrderCost(purchaseOrderId, { ...input, requestId });
    } catch {
      // A inclusão é idempotente pela requisição (D-869): repetir com os mesmos
      // dados devolve o custo já lançado. A tela relê a lista para mostrar se
      // ele entrou.
      avisarFalhaDeTransporte(
        "Não foi possível confirmar o lançamento do custo. Confira a lista: se ele já aparece, não precisa lançar de novo. Repetir com os mesmos dados não lança duas vezes.",
      );
      setBusy(false);
      reler(router);

      return;
    }

    setBusy(false);

    if (!r.ok) {
      setErro(r.message);

      return;
    }

    requisicoesDeCusto.delete(purchaseOrderId);
    setValor("");
    setDescricao("");
    router.refresh();
  }

  return (
    <div className="sb-pod-custos">
      {custos.length === 0 ? (
        <p className="sb-rep-mudo">Nenhum custo adicional lançado.</p>
      ) : (
        <table className="sb-table">
          <thead>
            <tr>
              <th>Custo</th>
              <th>Situação</th>
              <th className="sb-num">Valor</th>
              <th className="sb-num">Câmbio</th>
              {podeEditar && <th aria-label="Ações" />}
            </tr>
          </thead>
          <tbody>
            {custos.map((c) => (
              <tr key={c.id}>
                <td>
                  {PURCHASE_COST_KIND[c.kind] ?? c.kind}
                  {c.description !== null && <span className="sb-pod-item-title">{c.description}</span>}
                </td>
                <td>{c.status === "REALIZADO" ? "Realizado" : "Estimado"}</td>
                <td className="sb-num">
                  {c.currency === "BRL" ? formatCurrency(c.amount) : `${c.currency} ${formatCount(c.amount)}`}
                </td>
                <td className="sb-num">
                  {c.currency === "BRL" ? "—" : c.exchangeRate === null ? <span className="sb-pco-alerta-texto">pendente</span> : String(c.exchangeRate)}
                </td>
                {podeEditar && (
                  <td className="sb-num">
                    <button
                      type="button"
                      className="sb-button"
                      onClick={() => {
                        void deletePurchaseOrderCost(purchaseOrderId, c.id).then(
                          (r) => {
                            if (!r.ok) setErro(r.message);
                            else router.refresh();
                          },
                          () => {
                            avisarFalhaDeTransporte("Não foi possível confirmar a exclusão do custo. Confira a lista antes de excluir de novo.");
                            reler(router);
                          },
                        );
                      }}
                    >
                      Excluir
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {podeEditar && (
        <form
          className="sb-pod-custo-form"
          onSubmit={(e) => {
            e.preventDefault();
            void incluir();
          }}
        >
          <label className="sb-form-campo">
            <span>Tipo</span>
            <select
              className="sb-input"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
              }}
            >
              {Object.entries(PURCHASE_COST_KIND).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="sb-form-campo">
            <span>Valor</span>
            <input
              className="sb-input"
              inputMode="decimal"
              value={valor}
              onChange={(e) => {
                setValor(e.target.value);
              }}
              required
            />
          </label>
          <label className="sb-form-campo">
            <span>Moeda</span>
            <input
              className="sb-input sb-pod-moeda"
              maxLength={3}
              value={moeda}
              onChange={(e) => {
                setMoeda(e.target.value.toUpperCase());
              }}
            />
          </label>
          {moeda !== "BRL" && (
            <label className="sb-form-campo">
              <span>Câmbio (opcional)</span>
              <input
                className="sb-input"
                inputMode="decimal"
                value={cambio}
                onChange={(e) => {
                  setCambio(e.target.value);
                }}
                placeholder="pendente"
              />
            </label>
          )}
          <label className="sb-form-campo">
            <span>Situação</span>
            <select
              className="sb-input"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value === "REALIZADO" ? "REALIZADO" : "ESTIMADO");
              }}
            >
              <option value="ESTIMADO">Estimado</option>
              <option value="REALIZADO">Realizado</option>
            </select>
          </label>
          <label className="sb-form-campo sb-pod-custo-desc">
            <span>Descrição (opcional)</span>
            <input
              className="sb-input"
              maxLength={200}
              value={descricao}
              onChange={(e) => {
                setDescricao(e.target.value);
              }}
            />
          </label>
          <button type="submit" className="sb-button sb-button-primary" disabled={busy}>
            {busy ? "Salvando…" : "Incluir custo"}
          </button>
        </form>
      )}

      {erro !== null && (
        <p role="alert" className="sb-note sb-note-perigo">
          {erro}
        </p>
      )}
    </div>
  );
}
