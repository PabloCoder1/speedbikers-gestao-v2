import { redactSecretText } from "@sb/observability";

/**
 * Sanitização de texto de erro antes de chegar à tela (D-232).
 *
 * Nasceu dentro de `lib/integrations.ts` (D-231) e saiu de lá porque a revisão
 * adversarial mostrou o óbvio: uma "última linha antes da tela" que existe
 * numa tela só não é última linha — o mesmo `last_error` saía cru em
 * `/contas`, `/importacoes`, `/saude` e `/sincronizacao`, um clique depois do
 * card que o ocultava. Agora todas leem daqui.
 *
 * **As regras do que PARECE segredo moram em `@sb/observability` desde D-330**
 * (`redactSecretText`): por rótulo + forma, senha em DSN, e por forma sem rótulo
 * (`APP_USR-…`, `TG-…`, JWT, `sk-ant-…`). Elas nasceram aqui, e o logger não as
 * tinha — redigia só por NOME de chave, e deixava passar `{ reason:
 * error.message }` inteiro. Uma lista de regras, dois consumidores: a tela e o
 * log não conseguem mais discordar sobre o que é segredo.
 *
 * O que continua sendo só desta tela: esconder a query string, juntar espaços e
 * cortar no tamanho. Nenhum dos três é segredo — é leitura.
 *
 * Não é criptografia nem garantia: é a rede de segurança para o dia em que a
 * fonte deixar de ser limpa (D-217 lembra que hoje ela é).
 */

const QUERY_STRING = /\?[^\s"'<>]+/g;

export function sanitizeErrorText(text: string | null | undefined, max = 200): string | null {
  if (text === null || text === undefined) return null;

  let limpo = redactSecretText(text, "[oculto]");

  limpo = limpo.replace(QUERY_STRING, "?[oculto]").replace(/\s+/g, " ").trim();

  if (limpo === "") return null;

  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo;
}
