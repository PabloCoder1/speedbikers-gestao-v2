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

  async function salvarPrevisao(): Promise<void> {
    setBusy(true);
    setMsg(null);
    const r = await atualizarPrevisao(purchaseOrderId, previsao === "" ? null : previsao, nota === "" ? null : nota);
    setBusy(false);
    setMsg(r.ok ? { ok: true, texto: "Previsão atualizada." } : { ok: false, texto: r.message ?? "Não foi possível salvar." });
    if (r.ok) router.refresh();
  }

  async function salvarReferencia(): Promise<void> {
    setBusy(true);
    setMsg(null);
    const r = await vincularReferenciaExterna(purchaseOrderId, referencia, null);
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
