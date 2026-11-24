"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useDialogo } from "../../../components/use-dialogo";
import { formatCount } from "../../../lib/format";
import { LOGISTICS_STAGE } from "../../../lib/labels";
import {
  acrescentarAoPedidoExterno,
  registrarPedidoJaFeito,
  vincularReferenciaExterna,
  type CandidatoDuplicidade,
  type ResultadoRegistro,
} from "../compras/pedidos-ja-feitos-actions";

/**
 * "Já fiz o pedido deste produto" (D-761): o formulário compacto que registra
 * a compra feita fora do sistema. Só SKU e quantidade são obrigatórios; o que
 * não for preenchido fica DESCONHECIDO — nenhuma data, fornecedor ou
 * previsão é inventada.
 *
 * O banco decide a duplicidade. Se já existe pedido com a mesma referência ou
 * pedido em aberto com o mesmo SKU, a resposta volta com os candidatos e o
 * usuário escolhe: vincular a referência ao pedido existente, acrescentar o
 * SKU ao pedido externo, ou confirmar que é outro pedido. Nada é criado sem
 * essa escolha.
 */

export interface FornecedorOpcao {
  readonly id: string;
  readonly name: string;
}

const ETAPAS_DO_PEDIDO_FEITO = ["EM_PRODUCAO", "PRONTO_EMBARQUE", "EMBARCADO", "EM_TRANSITO", "DESEMBARACO", "TRANSPORTE_NACIONAL"];

const STATUS_CURTO: Record<string, string> = {
  DRAFT: "rascunho",
  APPROVED: "aprovado",
  ORDERED: "pedido feito",
  RECEIVED: "recebido",
};

function hojeLocal(): string {
  const d = new Date();

  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function JaFizPedido({
  skuId,
  sku,
  titulo,
  sugestao,
  fornecedores,
}: {
  skuId: string;
  sku: string;
  titulo: string | null;
  /** A sugestão atual, só para referência ao lado do campo. */
  sugestao: number | null;
  fornecedores: readonly FornecedorOpcao[];
}): ReactNode {
  const [aberto, setAberto] = useState(false);

  return (
    <>
      <button type="button" className="sb-text-button sb-pjf-abrir" onClick={() => { setAberto(true); }}>
        Já fiz o pedido
      </button>
      {/* No body, como a gaveta: dentro da tabela, um ancestral prenderia o position: fixed. */}
      {aberto &&
        createPortal(
          <Dialogo
            skuId={skuId}
            sku={sku}
            titulo={titulo}
            sugestao={sugestao}
            fornecedores={fornecedores}
            onFechar={() => {
              setAberto(false);
            }}
          />,
          document.body,
        )}
    </>
  );
}

function Dialogo({
  skuId,
  sku,
  titulo,
  sugestao,
  fornecedores,
  onFechar,
}: {
  skuId: string;
  sku: string;
  titulo: string | null;
  sugestao: number | null;
  fornecedores: readonly FornecedorOpcao[];
  onFechar: () => void;
}): ReactNode {
  const router = useRouter();
  const [quantidade, setQuantidade] = useState("");
  const [situacao, setSituacao] = useState<"PEDIDO_REALIZADO" | "PLANEJADO">("PEDIDO_REALIZADO");
  const [fornecedorId, setFornecedorId] = useState("");
  const [referencia, setReferencia] = useState("");
  const [dataPedido, setDataPedido] = useState("");
  const [previsao, setPrevisao] = useState("");
  const [etapa, setEtapa] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resposta, setResposta] = useState<ResultadoRegistro | null>(null);
  const [feito, setFeito] = useState<{ texto: string; pedidoId: string | null } | null>(null);
  // Uma requisição por formulário: o duplo clique e o repetir depois de falha
  // de rede devolvem o MESMO pedido (D-761).
  const requestId = useRef(crypto.randomUUID());
  const ref = useDialogo<HTMLDivElement>(true, onFechar, !gravando);

  const qtd = Number(quantidade.replace(/\./g, "").replace(",", "."));
  const qtdValida = Number.isFinite(qtd) && qtd > 0;

  async function registrar(confirmarNovo: boolean): Promise<void> {
    if (!qtdValida) {
      setErro("Informe a quantidade encomendada.");

      return;
    }

    setGravando(true);
    setErro(null);

    /*
      FALHA DE TRANSPORTE (D-866). Sem o `try`, `gravando` ficava ligado para
      sempre, e o diálogo, que não fecha enquanto grava, prendia a tela inteira.
      As três ações aceitam a repetição: registrar e acrescentar levam o mesmo
      `requestId` (D-761), e vincular é recusado se a referência já foi gravada.
    */
    let r: Awaited<ReturnType<typeof registrarPedidoJaFeito>>;

    try {
      r = await registrarPedidoJaFeito({
        requestId: requestId.current,
        itens: [{ skuId, quantity: qtd }],
        situacao,
        fornecedorId: fornecedorId === "" ? null : fornecedorId,
        referencia: referencia.trim() === "" ? null : referencia,
        dataPedido: dataPedido === "" ? null : dataPedido,
        previsao: previsao === "" ? null : previsao,
        etapa: situacao === "PEDIDO_REALIZADO" && etapa !== "" ? etapa : null,
        observacoes: observacoes.trim() === "" ? null : observacoes,
        confirmarNovo,
      });
    } catch {
      setErro("Não foi possível confirmar o registro. Tente de novo: o mesmo pedido não é registrado duas vezes.");
      setGravando(false);

      return;
    }

    setGravando(false);

    if (!r.ok) {
      setErro(r.message);

      return;
    }

    if (r.resultado === "CRIADO" || r.resultado === "JA_REGISTRADO") {
      setFeito({
        texto:
          situacao === "PLANEJADO"
            ? `Pedido nº ${String(r.pedido?.orderNumber ?? "")} registrado como planejado. A necessidade continua visível até a compra ser confirmada.`
            : `Pedido nº ${String(r.pedido?.orderNumber ?? "")} registrado. As ${formatCount(qtd)} un entram como pendentes de chegada e a sugestão já desconta.`,
        pedidoId: r.pedido?.id ?? null,
      });
      router.refresh();

      return;
    }

    setResposta(r);
  }

  async function vincular(c: CandidatoDuplicidade): Promise<void> {
    setGravando(true);
    setErro(null);

    let r: Awaited<ReturnType<typeof vincularReferenciaExterna>>;

    try {
      r = await vincularReferenciaExterna(c.purchaseOrderId, referencia, dataPedido === "" ? null : dataPedido);
    } catch {
      setErro(`Não foi possível confirmar se a referência foi vinculada. Abra o pedido nº ${String(c.orderNumber)} para conferir antes de tentar de novo.`);
      setGravando(false);

      return;
    }

    setGravando(false);

    if (!r.ok) {
      setErro(r.message);

      return;
    }

    setFeito({ texto: `A referência ${referencia.trim()} foi vinculada ao pedido nº ${String(c.orderNumber)}. Nenhuma quantidade mudou.`, pedidoId: c.purchaseOrderId });
    router.refresh();
  }

  async function acrescentar(c: CandidatoDuplicidade): Promise<void> {
    setGravando(true);
    setErro(null);

    let r: Awaited<ReturnType<typeof acrescentarAoPedidoExterno>>;

    try {
      r = await acrescentarAoPedidoExterno(c.purchaseOrderId, [{ skuId, quantity: qtd }], requestId.current);
    } catch {
      setErro("Não foi possível confirmar o acréscimo. Tente de novo: o mesmo acréscimo não é somado duas vezes.");
      setGravando(false);

      return;
    }

    setGravando(false);

    if (!r.ok) {
      setErro(r.message);

      return;
    }

    setFeito({ texto: `${sku} acrescentado ao pedido nº ${String(c.orderNumber)} com ${formatCount(qtd)} un.`, pedidoId: c.purchaseOrderId });
    router.refresh();
  }

  const temReferencia = referencia.trim() !== "";

  return (
    <div
      className="sb-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !gravando) onFechar();
      }}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="pjf-titulo" className="sb-modal sb-pjf-modal">
        <span className="sb-modal-eyebrow">PEDIDO JÁ FEITO</span>
        <h2 id="pjf-titulo">
          <span className="sb-mono">{sku}</span>
        </h2>
        <p>{titulo ?? "sem título"}</p>

        {feito !== null ? (
          <div className="sb-pjf-feito" role="status">
            <p>{feito.texto}</p>
            <div className="sb-pjf-acoes">
              {feito.pedidoId !== null && (
                <Link className="sb-button" href={`/compras/${feito.pedidoId}`}>
                  Ver pedido
                </Link>
              )}
              <button type="button" className="sb-button sb-button-primary" onClick={onFechar} data-foco-inicial>
                Fechar
              </button>
            </div>
          </div>
        ) : resposta !== null ? (
          <Candidatos
            resposta={resposta}
            temReferencia={temReferencia}
            gravando={gravando}
            onVincular={vincular}
            onAcrescentar={acrescentar}
            onRegistrarMesmoAssim={() => void registrar(true)}
            onVoltar={() => { setResposta(null); }}
            onFechar={onFechar}
          />
        ) : (
          <form
            className="sb-pjf-form"
            onSubmit={(e) => {
              e.preventDefault();
              // O portal leva o DOM ao body, mas o evento do React sobe pela árvore
              // de componentes: sem isto, o formulário da tabela (rep-pedido) recebe
              // este envio e quebra montando o FormData com um botão que não é dele.
              e.stopPropagation();
              void registrar(false);
            }}
          >
            <label className="sb-pjf-campo">
              <span>Quantidade encomendada *</span>
              <input
                className="sb-input"
                inputMode="decimal"
                value={quantidade}
                onChange={(e) => { setQuantidade(e.target.value); }}
                required
                data-foco-inicial
              />
              {sugestao !== null && sugestao > 0 && <small>sugestão atual: {formatCount(sugestao)} un</small>}
            </label>

            <fieldset className="sb-pjf-situacao">
              <legend>Situação</legend>
              <label>
                <input type="radio" checked={situacao === "PEDIDO_REALIZADO"} onChange={() => { setSituacao("PEDIDO_REALIZADO"); }} />
                Pedido realizado <small>confirmado com o fornecedor: conta como pendente de chegada</small>
              </label>
              <label>
                <input type="radio" checked={situacao === "PLANEJADO"} onChange={() => { setSituacao("PLANEJADO"); }} />
                Só planejado <small>ainda não comprado: não reduz a sugestão</small>
              </label>
            </fieldset>

            <div className="sb-pjf-grade">
              <label className="sb-pjf-campo">
                <span>Fornecedor</span>
                <select className="sb-input" value={fornecedorId} onChange={(e) => { setFornecedorId(e.target.value); }}>
                  <option value="">não informado</option>
                  {fornecedores.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sb-pjf-campo">
                <span>Nº ou referência do pedido</span>
                <input className="sb-input" value={referencia} maxLength={80} onChange={(e) => { setReferencia(e.target.value); }} placeholder="ex.: 30632-1" />
              </label>
              <label className="sb-pjf-campo">
                <span>Data do pedido</span>
                <input className="sb-input" type="date" max={hojeLocal()} value={dataPedido} onChange={(e) => { setDataPedido(e.target.value); }} />
              </label>
              <label className="sb-pjf-campo">
                <span>Previsão de chegada</span>
                <input className="sb-input" type="date" value={previsao} onChange={(e) => { setPrevisao(e.target.value); }} />
              </label>
              {situacao === "PEDIDO_REALIZADO" && (
                <label className="sb-pjf-campo">
                  <span>Situação logística</span>
                  <select className="sb-input" value={etapa} onChange={(e) => { setEtapa(e.target.value); }}>
                    <option value="">pedido realizado</option>
                    {ETAPAS_DO_PEDIDO_FEITO.map((s) => (
                      <option key={s} value={s}>
                        {LOGISTICS_STAGE[s] ?? s}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <label className="sb-pjf-campo">
              <span>Observações</span>
              <textarea className="sb-input" rows={2} maxLength={500} value={observacoes} onChange={(e) => { setObservacoes(e.target.value); }} />
            </label>

            <p className="sb-pjf-nota">
              Origem: pedido externo manual. O pedido entra pelo mesmo fluxo dos pedidos de compra, e a chegada, a
              previsão e o cancelamento se fazem na tela do pedido.
            </p>

            {erro !== null && (
              <p className="sb-pjf-erro" role="alert">
                {erro}
              </p>
            )}

            <div className="sb-pjf-acoes">
              <button type="button" className="sb-button" onClick={onFechar} disabled={gravando}>
                Cancelar
              </button>
              <button type="submit" className="sb-button sb-button-primary" disabled={gravando || !qtdValida}>
                {gravando ? "Registrando…" : "Registrar pedido"}
              </button>
            </div>
          </form>
        )}

        {resposta !== null && erro !== null && (
          <p className="sb-pjf-erro" role="alert">
            {erro}
          </p>
        )}
      </div>
    </div>
  );
}

function Candidatos({
  resposta,
  temReferencia,
  gravando,
  onVincular,
  onAcrescentar,
  onRegistrarMesmoAssim,
  onVoltar,
  onFechar,
}: {
  resposta: ResultadoRegistro;
  temReferencia: boolean;
  gravando: boolean;
  onVincular: (c: CandidatoDuplicidade) => Promise<void>;
  onAcrescentar: (c: CandidatoDuplicidade) => Promise<void>;
  onRegistrarMesmoAssim: () => void;
  onVoltar: () => void;
  onFechar: () => void;
}): ReactNode {
  const candidatos = resposta.candidatos ?? [];
  const mesmaReferencia = resposta.resultado === "REFERENCIA_EXISTENTE";

  return (
    <div className="sb-pjf-candidatos">
      <p className="sb-pjf-aviso" role="note">
        {mesmaReferencia
          ? "Já existe um pedido com esta referência deste fornecedor. Não é possível registrar outro igual."
          : "Encontramos pedidos que podem ser este mesmo. Escolha antes de registrar, para a mesma compra não contar duas vezes."}
      </p>

      <ul>
        {candidatos.map((c) => {
          const externo = c.origin !== "INTERNO";
          const podeVincular = c.motivo === "MESMO_SKU_EM_ABERTO" && c.externalReference === null && temReferencia;
          const podeAcrescentar = c.motivo === "MESMA_REFERENCIA" && externo && c.status !== "RECEIVED";

          return (
            <li key={`${c.motivo}-${c.purchaseOrderId}-${c.sku ?? ""}`}>
              <div>
                <Link href={`/compras/${c.purchaseOrderId}`} target="_blank">
                  Pedido nº {c.orderNumber}
                </Link>{" "}
                · {STATUS_CURTO[c.status] ?? c.status}
                {c.externalReference !== null && <> · ref. {c.externalReference}</>}
                {c.supplierName !== null && <> · {c.supplierName}</>}
                <small>
                  {c.motivo === "MESMA_REFERENCIA"
                    ? "mesma referência"
                    : `${c.sku ?? ""} em aberto${c.pendente === null ? "" : `: ${formatCount(c.pendente)} un`}`}
                  {externo ? " · externo" : " · interno"}
                </small>
              </div>
              <div className="sb-pjf-acoes">
                {podeVincular && (
                  <button type="button" className="sb-button sb-button-sm" disabled={gravando} onClick={() => void onVincular(c)}>
                    É este: vincular referência
                  </button>
                )}
                {c.motivo === "MESMO_SKU_EM_ABERTO" && !podeVincular && (
                  <button type="button" className="sb-button sb-button-sm" disabled={gravando} onClick={onFechar}>
                    É este: não registrar
                  </button>
                )}
                {podeAcrescentar && (
                  <button type="button" className="sb-button sb-button-sm" disabled={gravando} onClick={() => void onAcrescentar(c)}>
                    Acrescentar a este pedido
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="sb-pjf-acoes">
        <button type="button" className="sb-button" disabled={gravando} onClick={onVoltar}>
          Voltar
        </button>
        {!mesmaReferencia && (
          <button type="button" className="sb-button sb-button-primary" disabled={gravando} onClick={onRegistrarMesmoAssim}>
            É outro pedido: registrar
          </button>
        )}
      </div>
    </div>
  );
}
