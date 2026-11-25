"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { atualizarPrevisao, vincularReferenciaExterna } from "../pedidos-ja-feitos-actions";

/**
 * Previsão de chegada e referência externa do pedido em aberto (D-761, D-762).
 *
 * A previsão muda com histórico (EXPECTED_CHANGED, com o valor anterior e a
 * nota). Vazia = desconhecida, nunca uma data inventada. A referência só é
 * gravada quando o pedido ainda não tem uma: vincular nunca mexe em
 * quantidade, status ou trânsito.
 */
export function PrevisaoEReferencia({
  purchaseOrderId,
  expectedAt,
  externalReference,
}: {
  purchaseOrderId: string;
  expectedAt: string | null;
  externalReference: string | null;
}): ReactNode {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [previsao, setPrevisao] = useState(expectedAt?.slice(0, 10) ?? "");
  const [nota, setNota] = useState("");
  const [referencia, setReferencia] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);

  /*
    FALHA DE TRANSPORTE (D-865): sem o `try`, os dois botões ficavam
    desligados para sempre. Os campos ficam como estavam.
  */
  async function salvarPrevisao(): Promise<void> {
    setBusy(true);
    setMsg(null);
    let r: Awaited<ReturnType<typeof atualizarPrevisao>>;

    try {
      r = await atualizarPrevisao(purchaseOrderId, previsao === "" ? null : previsao, nota === "" ? null : nota);
    } catch {
      setBusy(false);
      setMsg({ ok: false, texto: "Não foi possível confirmar se a previsão foi salva. Tente de novo." });

      return;
    }

    setBusy(false);
    setMsg(r.ok ? { ok: true, texto: "Previsão atualizada." } : { ok: false, texto: r.message ?? "Não foi possível salvar." });
    if (r.ok) router.refresh();
  }

  async function salvarReferencia(): Promise<void> {
    setBusy(true);
    setMsg(null);
    let r: Awaited<ReturnType<typeof vincularReferenciaExterna>>;

    try {
      r = await vincularReferenciaExterna(purchaseOrderId, referencia, null);
    } catch {
      // A referência só é gravada se o pedido ainda não tiver uma: se a primeira
      // tentativa gravou, a repetição é recusada. A tela relê o pedido.
      setBusy(false);
      setMsg({
        ok: false,
        texto: "Não foi possível confirmar se a referência foi vinculada. Confira o pedido antes de vincular de novo.",
      });

      try {
        router.refresh();
      } catch {
        // Sem rede, a releitura também falha; o aviso já está na tela.
      }

      return;
    }

    setBusy(false);
    setMsg(r.ok ? { ok: true, texto: "Referência vinculada." } : { ok: false, texto: r.message ?? "Não foi possível salvar." });
    if (r.ok) router.refresh();
  }

  if (!aberto) {
    return (
      <button type="button" className="sb-button" onClick={() => { setAberto(true); }}>
        Atualizar previsão{externalReference === null ? " ou referência" : ""}
      </button>
    );
  }

  return (
    <div className="sb-pjf-previsao">
      <label className="sb-pjf-campo">
        <span>Previsão de chegada</span>
        <input className="sb-input" type="date" value={previsao} onChange={(e) => { setPrevisao(e.target.value); }} />
        <small>vazia = desconhecida</small>
      </label>
      <label className="sb-pjf-campo">
        <span>Motivo (opcional)</span>
        <input className="sb-input" maxLength={200} value={nota} onChange={(e) => { setNota(e.target.value); }} placeholder="ex.: navio atrasou" />
      </label>
      <button type="button" className="sb-button sb-button-primary" disabled={busy} onClick={() => void salvarPrevisao()}>
        Salvar previsão
      </button>

      {externalReference === null && (
        <>
          <label className="sb-pjf-campo">
            <span>Referência no fornecedor / controle de chegada</span>
            <input className="sb-input" maxLength={80} value={referencia} onChange={(e) => { setReferencia(e.target.value); }} placeholder="ex.: 30632-1" />
          </label>
          <button type="button" className="sb-button" disabled={busy || referencia.trim() === ""} onClick={() => void salvarReferencia()}>
            Vincular referência
          </button>
        </>
      )}

      {msg !== null && (
        <p className={msg.ok ? "sb-pjf-ok" : "sb-pjf-erro"} role={msg.ok ? "status" : "alert"}>
          {msg.texto}
        </p>
      )}
      <button type="button" className="sb-button" onClick={() => { setAberto(false); }}>
        Fechar
      </button>
    </div>
  );
}
