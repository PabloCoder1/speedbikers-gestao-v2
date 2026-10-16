"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import { createKnowledgeEntry } from "./actions";
import {
  KNOWLEDGE_KINDS,
  KNOWLEDGE_KIND_LABEL,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_SOURCE_LABEL,
  type KnowledgeKind,
  type KnowledgeSource,
} from "./constants";

/** Qualquer membro pode sugerir; a policy do banco obriga o estado SUGERIDO. */
export function NewKnowledgeForm(): ReactNode {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<KnowledgeKind>("COMPATIBILIDADE");
  const [source, setSource] = useState<KnowledgeSource>("CONFIRMACAO_INTERNA");
  const [skuCode, setSkuCode] = useState("");
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, busy]);

  function close(): void {
    if (!busy) setOpen(false);
  }

  function submit(): void {
    setBusy(true);
    setFeedback(null);
    void createKnowledgeEntry({ kind, source, content, note, skuCode }).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setFeedback({ ok: false, text: result.message ?? "Não foi possível registrar." });
        return;
      }
      setContent("");
      setNote("");
      setSkuCode("");
      setFeedback({ ok: true, text: "Registrado como SUGERIDO. Aguarda validação humana." });
    });
  }

  return <>
    <button className="sb-button sb-button-primary" type="button" onClick={() => { setFeedback(null); setOpen(true); }}>
      Novo conhecimento
    </button>
    {open && <div className="sb-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="sb-modal sb-knowledge-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="sb-knowledge-modal-head">
          <div><span className="sb-modal-eyebrow">NOVO CONHECIMENTO</span><h2 id={titleId}>Enviar para validação</h2></div>
          <button className="sb-close" type="button" aria-label="Fechar" onClick={close} disabled={busy}>×</button>
        </div>
        <p>O registro nasce como sugerido. Só ADMIN ou GESTOR pode validá-lo para o Copiloto.</p>
        <div className="sb-knowledge-form">
          <div className="sb-knowledge-form-grid">
            <label>Tipo<select className="sb-input" value={kind} onChange={(event) => { setKind(event.target.value as KnowledgeKind); }}>{KNOWLEDGE_KINDS.map((option) => <option key={option} value={option}>{KNOWLEDGE_KIND_LABEL[option]}</option>)}</select></label>
            <label>Fonte<select className="sb-input" value={source} onChange={(event) => { setSource(event.target.value as KnowledgeSource); }}>{KNOWLEDGE_SOURCES.map((option) => <option key={option} value={option}>{KNOWLEDGE_SOURCE_LABEL[option]}</option>)}</select></label>
          </div>
          <label>SKU <span className="sb-knowledge-hint">(opcional; vazio = geral)</span><input className="sb-input" value={skuCode} maxLength={120} onChange={(event) => { setSkuCode(event.target.value); }} /></label>
          <label>Fato confirmado ou a revisar<textarea className="sb-input" autoFocus value={content} rows={4} maxLength={500} onChange={(event) => { setContent(event.target.value); }} placeholder="Ex.: Compatível com Honda X-ADV 750 2022–2025" /></label>
          <label>Observação <span className="sb-knowledge-hint">(opcional)</span><textarea className="sb-input" value={note} rows={2} maxLength={1000} onChange={(event) => { setNote(event.target.value); }} /></label>
          {feedback !== null && <p className={feedback.ok ? "sb-knowledge-feedback" : "sb-knowledge-feedback sb-knowledge-feedback-error"} role={feedback.ok ? "status" : "alert"}>{feedback.text}</p>}
          <div className="sb-knowledge-form-actions">
            <button className="sb-button" type="button" disabled={busy} onClick={close}>{feedback?.ok ? "Concluído" : "Cancelar"}</button>
            {!feedback?.ok && <button className="sb-button sb-button-primary" type="button" disabled={busy} onClick={submit}>{busy ? "Registrando…" : "Enviar para validação"}</button>}
          </div>
        </div>
      </section>
    </div>}
  </>;
}
