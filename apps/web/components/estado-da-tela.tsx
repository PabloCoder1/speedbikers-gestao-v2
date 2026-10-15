import Link from "next/link";
import type { ReactNode } from "react";

import { sanitizeErrorText } from "../lib/sanitize";
import { Icone, type NomeDoIcone } from "./icons";
import { LinkDeFiltro } from "./link-de-filtro";

/**
 * O ESTADO de uma tela ou de um painel quando não há tabela para mostrar —
 * erro de leitura, nada ainda, filtro sem resultado ou sem permissão (D-502).
 *
 * Era uma forma por módulo: a auditoria de 14/10 (`docs/UX_SYSTEM.md` §2, itens
 * 7, 9, 10 e 17) contou o erro de leitura em sete formas visuais diferentes, o
 * vazio em ~15 classes próprias mais o `.sb-empty`, a recusa de papel sem
 * caminho de volta, e "Tentar de novo" ao lado de "Tentar novamente". Esta é a
 * forma única, tirada da que `/estoque/movimentacoes` e `/precos` já usavam:
 * ícone, o que aconteceu, o que fazer, e a ação que resolve.
 *
 * **Os quatro tipos dizem coisas diferentes, e a diferença importa:**
 *
 * - `erro` — a LEITURA falhou. Não é "não há dados": o dado pode existir. Tem
 *   `role="alert"` (é a única falha real da lista) e o `detalhe` técnico, que
 *   passa pelo `sanitizeErrorText` antes de chegar à tela.
 * - `vazio` — leu, e não há nada ainda. Diz quando passa a haver.
 * - `filtro` — há dados, mas não neste recorte. A ação natural é tirar o
 *   filtro, e ela é navegação na mesma tela.
 * - `permissao` — o papel da pessoa não alcança. Diz o papel exigido; a defesa
 *   continua sendo a RLS e a api, não esta tela (D-295 §3).
 *
 * `acao.mesmaTela` usa o `LinkDeFiltro` (a atualização no lugar de D-500) —
 * "Tentar de novo" e "Limpar filtros" ficam na tela; "Ir para o início" não.
 */
export type TipoDeEstado = "erro" | "vazio" | "filtro" | "permissao";

export interface AcaoDoEstado {
  readonly href: string;
  readonly rotulo: string;
  /** O destino é a própria tela (outra `?busca`): mostra a atualização no lugar. */
  readonly mesmaTela?: boolean;
}

const ICONE: Record<TipoDeEstado, NomeDoIcone> = {
  erro: "pulso",
  vazio: "bandeja",
  filtro: "lupa",
  permissao: "pessoas",
};

/** O rótulo do "tente de novo" — um só no app (eram "de novo" × "novamente"). */
export const TENTAR_DE_NOVO = "Tentar de novo";

export function EstadoDaTela({
  tipo,
  titulo,
  descricao,
  detalhe,
  acao,
  nivel = "bloco",
}: {
  tipo: TipoDeEstado;
  titulo: string;
  descricao?: ReactNode | undefined;
  /** Texto técnico do erro (`error.message`): sanitizado e encurtado antes da tela. */
  detalhe?: string | null | undefined;
  acao?: AcaoDoEstado | undefined;
  /** `tela` quando o estado É a tela (recusa de papel): centralizado e com mais ar. */
  nivel?: "bloco" | "tela";
}): ReactNode {
  const detalheLimpo = tipo === "erro" ? sanitizeErrorText(detalhe, 160) : null;
  const classes = `sb-estado sb-estado-${tipo}${nivel === "tela" ? " sb-estado-tela" : ""}`;

  return (
    <div className={classes} role={tipo === "erro" ? "alert" : undefined}>
      <span className="sb-estado-icone" aria-hidden="true">
        <Icone nome={ICONE[tipo]} tamanho={18} />
      </span>
      <div className="sb-estado-texto">
        <strong>{titulo}</strong>
        {descricao !== undefined && <p>{descricao}</p>}
        {detalheLimpo !== null && <code className="sb-estado-detalhe">{detalheLimpo}</code>}
      </div>
      {acao !== undefined &&
        (acao.mesmaTela === true ? (
          <LinkDeFiltro className="sb-button" href={acao.href}>
            {acao.rotulo}
          </LinkDeFiltro>
        ) : (
          <Link className="sb-button" href={acao.href}>
            {acao.rotulo}
          </Link>
        ))}
    </div>
  );
}
