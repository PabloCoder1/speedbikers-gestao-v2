"use client";

import { useId, useState, type ReactNode } from "react";

import { StatePill } from "../../../components/state-pill";
import { formatCount, formatDay, formatPercent } from "../../../lib/format";
import {
  CAIXA_LIMITE,
  estaApertado,
  NOME_LIMITE,
  ocupacaoDaCaixa,
} from "../../../lib/template-filters";
import type { TemplateActionResult } from "./actions";
import { deleteTemplate, duplicateTemplate, updateTemplate } from "./actions";

/**
 * Um template na lista (D-111; refeito em D-392).
 *
 * Continua com **edição inline, sem modal** — mesmo espírito das preferências
 * de notificação (D-076): o texto que se edita é o mesmo que se estava lendo,
 * no lugar onde estava. O que mudou é o que a linha CONTA antes de alguém
 * clicar em editar: o tamanho contra a caixa de resposta, quem escreveu e
 * quando foi mexido pela última vez.
 *
 * **O texto longo nasce dobrado.** Um template de 2.000 caracteres empurrava
 * os outros três para fora da tela; agora ele mostra as primeiras linhas e
 * abre por clique — sem esconder nada, porque a dobra é do LEITOR, não do
 * dado (o texto inteiro está no DOM e vai junto na busca do navegador).
 */

export interface TemplateRowData {
  id: string;
  name: string;
  body: string;
  /** Quem escreveu. Nulo quando o autor saiu (`created_by on delete set null`). */
  autor: string | null;
  atualizadoEm: string;
}

/** Quantos caracteres cabem na prévia antes de valer a pena dobrar. */
const PREVIA = 320;

/**
 * Recorta o texto em volta do termo buscado, sem regex.
 *
 * Marcar o trecho encontrado responde "por que este template apareceu?" quando
 * o casamento foi no TEXTO e não no nome. É `indexOf` em caixa baixa de
 * propósito: termo de busca é texto de usuário, e montar `RegExp` com ele
 * transformaria um `(` digitado sem querer numa exceção.
 */
function marcar(texto: string, termo: string | null): ReactNode {
  if (termo === null || termo === "") return texto;

  const alvo = termo.toLowerCase();
  const fonte = texto.toLowerCase();
  const pedacos: ReactNode[] = [];
  let cursor = 0;

  for (let achado = fonte.indexOf(alvo); achado !== -1; achado = fonte.indexOf(alvo, cursor)) {
    if (achado > cursor) pedacos.push(texto.slice(cursor, achado));

    pedacos.push(
      <mark key={`${String(achado)}-${alvo}`} className="sb-template-marca">
        {texto.slice(achado, achado + alvo.length)}
      </mark>,
    );
    cursor = achado + alvo.length;
  }

  if (cursor === 0) return texto;
  if (cursor < texto.length) pedacos.push(texto.slice(cursor));

  return pedacos;
}

export function TemplateRow({
  template,
  canManage,
  termo,
}: {
  template: TemplateRowData;
  canManage: boolean;
  /** Termo buscado, para marcar o trecho que fez o template aparecer. */
  termo?: string | null;
}): ReactNode {
  const [editando, setEditando] = useState(false);
  const [aberto, setAberto] = useState(false);
  const [name, setName] = useState(template.name);
  const [body, setBody] = useState(template.body);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Apagar não tem volta: pede um segundo clique, na própria linha (lote 2 do
  // pente fino, 18/09 — antes o primeiro clique já apagava).
  const [confirmando, setConfirmando] = useState(false);
  const nomeId = useId();
  const textoId = useId();

  const ocupacao = ocupacaoDaCaixa(template.body);
  const apertado = estaApertado(template.body);
  const longo = template.body.length > PREVIA;
  const restam = CAIXA_LIMITE - body.length;
  const invalido = name.trim().length === 0 || body.trim().length === 0;

  async function run(acao: () => Promise<TemplateActionResult>, sucesso?: string): Promise<void> {
    setBusy(true);
    setErro(null);
    setAviso(null);

    const resultado = await acao();

    setBusy(false);

    if (!resultado.ok) {
      setErro(resultado.message);

      return;
    }

    setConfirmando(false);
    setEditando(false);

    if (sucesso !== undefined) setAviso(sucesso);
  }

  function copiar(): void {
    setErro(null);
    void navigator.clipboard.writeText(template.body).then(
      () => {
        setAviso("Texto copiado.");
      },
      () => {
        // Sem permissão de área de transferência (navegador antigo, http): o
        // texto continua inteiro na tela, então o caminho manual existe.
        setErro("O navegador não deixou copiar. Selecione o texto e copie à mão.");
      },
    );
  }

  return (
    <li className={apertado ? "sb-template-card sb-template-card-apertado" : "sb-template-card"}>
      {editando ? (
        <div className="sb-template-edicao">
          <label className="sb-template-campo" htmlFor={`${nomeId}-nome`}>
            <span>Nome</span>
            <input
              className="sb-input"
              id={`${nomeId}-nome`}
              value={name}
              maxLength={NOME_LIMITE}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </label>

          <label className="sb-template-campo" htmlFor={`${textoId}-texto`}>
            <span>
              Texto
              <em className={restam < 0 ? "sb-template-contador sb-template-contador-estourou" : "sb-template-contador"}>
                {formatCount(body.length)} de {formatCount(CAIXA_LIMITE)} caracteres da caixa
              </em>
            </span>
            <textarea
              className="sb-input sb-template-textarea"
              id={`${textoId}-texto`}
              value={body}
              rows={8}
              maxLength={CAIXA_LIMITE}
              onChange={(event) => {
                setBody(event.target.value);
              }}
            />
          </label>

          <div className="sb-template-actions">
            <button
              className="sb-button sb-button-primary"
              type="button"
              disabled={busy || invalido}
              onClick={() => void run(() => updateTemplate(template.id, name, body), "Template salvo.")}
            >
              {busy ? "Salvando…" : "Salvar"}
            </button>
            <button
              className="sb-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setName(template.name);
                setBody(template.body);
                setErro(null);
                setEditando(false);
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="sb-template-cabeca">
            <strong className="sb-template-name">{marcar(template.name, termo ?? null)}</strong>
            <span className="sb-template-selos">
              {apertado && <StatePill tone={{ tom: "atencao", label: "APERTADO" }} />}
              <span className="sb-template-ocupacao" title={`${formatCount(template.body.length)} de ${formatCount(CAIXA_LIMITE)} caracteres da caixa de resposta`}>
                {formatPercent(ocupacao)} da caixa
              </span>
            </span>
          </div>

          <p className="sb-template-meta">
            {template.autor === null ? "Autor não identificado" : `Escrito por ${template.autor}`} ·
            atualizado em {formatDay(template.atualizadoEm)}
          </p>

          <p className={aberto || !longo ? "sb-template-body" : "sb-template-body sb-template-body-dobrado"}>
            {marcar(template.body, termo ?? null)}
          </p>

          {longo && (
            <button
              className="sb-text-button"
              type="button"
              aria-expanded={aberto}
              onClick={() => {
                setAberto(!aberto);
              }}
            >
              {aberto ? "Ver menos" : "Ver texto inteiro"}
            </button>
          )}

          {!confirmando && (
            <div className="sb-template-actions">
              <button className="sb-button" type="button" disabled={busy} onClick={copiar}>
                Copiar texto
              </button>
              {canManage && (
                <>
                  <button
                    className="sb-button"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setAviso(null);
                      setErro(null);
                      setEditando(true);
                    }}
                  >
                    Editar
                  </button>
                  <button
                    className="sb-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => duplicateTemplate(template.id), "Cópia criada — ela aparece na lista.")}
                  >
                    Duplicar
                  </button>
                  <button
                    className="sb-button sb-template-danger"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirmando(true);
                    }}
                  >
                    Apagar
                  </button>
                </>
              )}
            </div>
          )}

          {canManage && confirmando && (
            <div className="sb-template-confirm" role="group" aria-label="Confirmar exclusão">
              <span>Apagar “{template.name}”? Não dá para desfazer.</span>
              <button
                className="sb-button sb-template-danger"
                type="button"
                disabled={busy}
                onClick={() => void run(() => deleteTemplate(template.id))}
              >
                {busy ? "Apagando…" : "Sim, apagar"}
              </button>
              <button
                className="sb-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmando(false);
                }}
              >
                Cancelar
              </button>
            </div>
          )}
        </>
      )}

      {erro !== null && (
        <p role="alert" className="sb-template-error">
          {erro}
        </p>
      )}

      {aviso !== null && (
        <p role="status" className="sb-template-aviso">
          {aviso}
        </p>
      )}
    </li>
  );
}
