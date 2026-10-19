"use client";

import { useActionState, type ReactNode } from "react";

import type { CampoDosLimites } from "../../../../lib/limites-central";
import type { ResultadoDoCadastro } from "../metas/actions";
import { Campo, Mensagem } from "../metas/formularios";
import { salvarLimites } from "./actions";

const INICIAL: ResultadoDoCadastro = { ok: false, mensagem: null, erros: {} };

export interface DescricaoDoLimite {
  readonly campo: CampoDosLimites;
  readonly rotulo: string;
  readonly dica: string;
  /** O que o limite controla e o efeito de subir ou baixar, a um toque (UX_SYSTEM §6, bloco 2). */
  readonly ajuda: string;
  /** O valor como a pessoa escreve: "2", "0,5", "20". */
  readonly atual: string;
}

export interface GrupoDeLimites {
  readonly id: string;
  readonly titulo: string;
  readonly descricao: string;
  readonly limites: readonly DescricaoDoLimite[];
}

/**
 * O formulário inteiro: os nove limites juntos, porque as regras cruzam campos
 * (forte acima de estável), agrupados pelo que controlam (UX_SYSTEM §6, bloco 2).
 * Os nomes dos campos não mudam: a ação lê os nove de uma vez.
 */
export function FormularioLimites({ grupos }: { grupos: readonly GrupoDeLimites[] }): ReactNode {
  const [resultado, enviar, salvando] = useActionState(salvarLimites, INICIAL);

  return (
    <form action={enviar} className="sb-limites-form" aria-label="Limites da central">
      <p className="sb-form-legenda">
        Todos os campos são obrigatórios. Cada um mostra o padrão do sistema; &quot;Voltar aos padrões&quot; desfaz tudo de uma vez.
      </p>

      {grupos.map((grupo) => (
        <fieldset key={grupo.id} className="sb-limites-grupo">
          <legend>{grupo.titulo}</legend>
          <p className="sb-limites-grupo-descricao">{grupo.descricao}</p>

          <div className="sb-cadastro-form">
            {grupo.limites.map((l) => (
              <Campo
                key={l.campo}
                nome={l.campo}
                rotulo={l.rotulo}
                dica={l.dica}
                erro={resultado.erros[l.campo]}
                ajuda={{ pergunta: "O que muda se eu aumentar ou diminuir?", texto: <p>{l.ajuda}</p> }}
              >
                {(props) => (
                  <input {...props} className="sb-input" name={l.campo} inputMode="decimal" defaultValue={l.atual} required />
                )}
              </Campo>
            ))}
          </div>
        </fieldset>
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
