import type { ReactNode } from "react";

import { AbasDaSecao } from "../../../components/abas-da-secao";
import { PageTitle } from "../../../components/page-title";
import { abasDaCentral, type TelaDaCentral } from "../../../lib/central-navegacao";

/**
 * O QUE AS SEIS TELAS DA CENTRAL REPETIAM, NUM LUGAR SÓ (UX_SYSTEM §6, bloco 4).
 *
 * A auditoria de 19/10 (§6.3, item 10) contou a resposta da RPC declarada 4
 * vezes, o "SENDO ATIVADO" escrito 7 vezes e o título com as abas montado à mão
 * em cada tela. Aqui fica a forma única; o texto de cada tela continua nela.
 */

/** A resposta de uma RPC do PostgREST como as telas a leem: o dado cru e o erro com o código. */
export interface RespostaComCodigo {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/**
 * A função ainda não existe neste banco (PGRST202). Não é falha: a web da
 * `main` chega à produção antes de a migration passar pelo workflow (o
 * precedente de D-363), e a tela diz que está "sendo ativada".
 */
export function funcaoAusente(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202";
}

/** O aviso de função ou tabela que ainda não chegou a este banco; o texto diz o que falta e o que passa a funcionar. */
export function SendoAtivado({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="sb-note">
      <span>SENDO ATIVADO</span>
      <p>{children}</p>
    </div>
  );
}

/**
 * O título de uma tela da Central e as abas logo abaixo (D-517). A `consulta`
 * é o recorte que as abas levam: a tela passa só o que aplicou (o período
 * recusado não viaja).
 */
export function CabecalhoDaCentral({
  tela,
  consulta,
  titulo,
  subtitulo,
  aside,
}: {
  tela: TelaDaCentral;
  consulta: Parameters<typeof abasDaCentral>[1];
  titulo: string;
  subtitulo: ReactNode;
  aside?: ReactNode;
}): ReactNode {
  return (
    <>
      <PageTitle eyebrow="COMERCIAL / CENTRAL" title={titulo} subtitle={subtitulo} aside={aside} />
      <AbasDaSecao rotulo="Telas da central" abas={abasDaCentral(tela, consulta)} />
    </>
  );
}

/** O período personalizado recusado: a tela mostra o padrão e diz isso (não é falha, D-503). */
export function AvisoDePeriodoInvalido({ rotulo }: { rotulo: string }): ReactNode {
  return (
    <p role="status" className="sb-note sb-note-atencao" style={{ margin: "0 0 var(--sb-space-3)" }}>
      Período personalizado inválido — mostrando {rotulo.toLowerCase()}.
    </p>
  );
}
