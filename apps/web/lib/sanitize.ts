import { SENSITIVE_KEY_NAMES } from "@sb/observability";

/**
 * Sanitização de texto de erro antes de chegar à tela (D-232).
 *
 * Nasceu dentro de `lib/integrations.ts` (D-231) e saiu de lá porque a revisão
 * adversarial mostrou o óbvio: uma "última linha antes da tela" que existe
 * numa tela só não é última linha — o mesmo `last_error` saía cru em
 * `/contas`, `/importacoes`, `/saude` e `/sincronizacao`, um clique depois do
 * card que o ocultava. Agora todas leem daqui.
 *
 * Duas famílias de regra, e a ordem importa:
 *
 * 1. **Por rótulo + forma**: `chave=valor`, `chave: valor`, `"chave":"valor"`,
 *    `Authorization: Bearer valor`. Os nomes de chave vêm de UMA lista — a
 *    mesma que o logger de `@sb/observability` usa para redigir contexto —
 *    mais dois que só aparecem em texto de tela (`senha`, `bearer`). Duas
 *    listas para o mesmo conceito era o que a revisão apontou.
 * 2. **Por forma, sem rótulo**: o token do Mercado Livre (`APP_USR-…`), o
 *    refresh (`TG-…`), JWT (`eyJ…`), chave da Anthropic (`sk-ant-…`) e senha
 *    embutida em DSN (`://usuario:senha@host`). A revisão executou o regex
 *    antigo contra `Authorization: Bearer eyJ…` e o JWT saiu inteiro — porque o
 *    desenho só conhecia rótulos.
 *
 * Não é criptografia nem garantia: é a rede de segurança para o dia em que a
 * fonte deixar de ser limpa (D-217 lembra que hoje ela é).
 */

const KEY_NAMES = [...SENSITIVE_KEY_NAMES, "senha", "bearer"];

// `["']?` antes do separador cobre `"access_token":"…"` (JSON); `(?:bearer\s+)?`
// depois cobre `Authorization: Bearer <token>`; o valor aceita qualquer coisa
// que não seja espaço ou aspa, porque `!`, `%` e `,` aparecem em segredo real.
const LABELED_SECRET = new RegExp(
  `(${KEY_NAMES.join("|")})["']?(\\s*[=:]\\s*|\\s+)["']?(?:bearer\\s+)?([^\\s"'<>]{6,})`,
  "gi",
);

const UNLABELED_SECRETS: readonly RegExp[] = [
  /\bAPP_USR-[A-Za-z0-9%-]{10,}/g,
  /\bTG-[A-Za-z0-9%-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
];

const DSN_CREDENTIALS = /:\/\/[^/\s@:]+:[^@\s]+@/g;
const QUERY_STRING = /\?[^\s"'<>]+/g;

export function sanitizeErrorText(text: string | null | undefined, max = 200): string | null {
  if (text === null || text === undefined) return null;

  // Um valor rotulado só é tratado como segredo se PARECER segredo: tem dígito
  // ou é longo. Sem isso o filtro comia texto benigno — "troca de token:
  // invalid_client" virava "token=[oculto]", e a mensagem real do ml-token.ts
  // deixava de dizer o que aconteceu. Tokens reais (APP_USR-…, TG-…, JWT,
  // chaves) sempre carregam dígito; os que não carregam caem nas regras de
  // forma abaixo.
  //
  // O BURACO QUE ISSO ABRE, dito em vez de escondido: um valor rotulado curto,
  // todo minúsculo e sem dígito — `senha=correcthorse` — passa. Nenhum segredo
  // de máquina tem essa forma (são base64, hex ou prefixados), mas uma senha
  // escolhida por gente tem. A troca foi deliberada: preferir a mensagem de
  // erro legível ao mascaramento de uma forma que a fonte não produz.
  let limpo = text
    .replace(LABELED_SECRET, (match: string, chave: string, _sep: string, valor: string) =>
      /\d/.test(valor) || valor.length >= 20 ? `${chave}=[oculto]` : match,
    )
    .replace(DSN_CREDENTIALS, "://[oculto]@");

  for (const padrao of UNLABELED_SECRETS) {
    limpo = limpo.replace(padrao, "[oculto]");
  }

  limpo = limpo.replace(QUERY_STRING, "?[oculto]").replace(/\s+/g, " ").trim();

  if (limpo === "") return null;

  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo;
}
