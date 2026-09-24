"use client";

import { useActionState, type ReactNode } from "react";

import type { CampoDosLimites } from "../../../lib/limites-central";
import type { ResultadoDoCadastro } from "../metas/actions";
import { Campo, Mensagem } from "../metas/formularios";
import { salvarLimites } from "./actions";

const INICIAL: ResultadoDoCadastro = { ok: false, mensagem: null, erros: {} };

export interface DescricaoDoLimite {
  readonly campo: CampoDosLimites;
  readonly rotulo: string;
  readonly dica: string;
  /** O valor como a pessoa escreve: "2", "0,5", "20". */
  readonly atual: string;
}

/** O formulário inteiro: os sete limites juntos, porque as regras cruzam campos (forte acima de estável). */
export function FormularioLimites({ limites }: { limites: readonly DescricaoDoLimite[] }): ReactNode {
  const [resultado, enviar, salvando] = useActionState(salvarLimites, INICIAL);

  return (
    <form action={enviar} className="sb-cadastro-form" aria-label="Limites da central">
      {limites.map((l) => (
        <Campo key={l.campo} nome={l.campo} rotulo={l.rotulo} dica={l.dica} erro={resultado.erros[l.campo]}>
          {(props) => (
            <input {...props} className="sb-input" name={l.campo} inputMode="decimal" defaultValue={l.atual} required />
          )}
        </Campo>
      ))}

      <div className="sb-cadastro-acoes">
        <button type="submit" className="sb-button sb-button-primary" disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar limites"}
        </button>
        <Mensagem resultado={resultado} />
      </div>
    </form>
  );
}
