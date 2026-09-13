/**
 * O QUE PARECE SEGREDO — a lista de nomes e as regras de texto, num lugar só
 * (D-232, completado em D-330).
 *
 * D-232 começou a "uma lista, dois consumidores": os NOMES de chave passaram a
 * ser compartilhados entre o logger e o sanitizador de tela. As regras de VALOR
 * — o token do Mercado Livre sem rótulo, o JWT depois de `Bearer`, a senha dentro
 * de um DSN — ficaram só na tela. O logger redigia por nome de chave e deixava
 * passar `{ reason: error.message }` inteiro, e é exatamente por esse campo que
 * a mensagem de um cliente de terceiro chega ao log.
 *
 * Medido antes de mexer (D-330): em sete dias de log do Dev, **zero** ocorrências
 * de `APP_USR-`, `sk-ant-`, JWT ou `Bearer ` — a fonte é limpa hoje. Isto é a
 * rede para o dia em que ela deixar de ser, que é o que D-217 lembra.
 *
 * Este módulo não importa o logger, e o logger importa este módulo: morar em
 * `logger.ts` faria o sanitizador de tela depender do logger inteiro.
 */

/**
 * Nomes de chave cujo valor nunca pode chegar ao log nem à tela.
 *
 * `docs/ARCHITECTURE.md` secao 18: token do Mercado Livre nunca em log, nem
 * parcialmente. Redigir por nome de chave é o único filtro que continua
 * funcionando quando alguém despeja um objeto inteiro por engano.
 */
export const SENSITIVE_KEY_NAMES: readonly string[] = [
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "api[-_]?key",
  "credential",
  "cookie",
];

/** Rótulos que só aparecem em TEXTO (mensagem, corpo), nunca como chave de contexto. */
const TEXT_ONLY_KEY_NAMES = ["senha", "bearer"];

// `["']?` antes do separador cobre `"access_token":"…"` (JSON); `(?:bearer\s+)?`
// depois cobre `Authorization: Bearer <token>`; o valor aceita qualquer coisa
// que não seja espaço ou aspa, porque `!`, `%` e `,` aparecem em segredo real.
const LABELED_SECRET = new RegExp(
  `(${[...SENSITIVE_KEY_NAMES, ...TEXT_ONLY_KEY_NAMES].join("|")})["']?(\\s*[=:]\\s*|\\s+)["']?(?:bearer\\s+)?([^\\s"'<>]{6,})`,
  "gi",
);

const UNLABELED_SECRETS: readonly RegExp[] = [
  /\bAPP_USR-[A-Za-z0-9%-]{10,}/g,
  /\bTG-[A-Za-z0-9%-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
];

const DSN_CREDENTIALS = /:\/\/[^/\s@:]+:[^@\s]+@/g;

/**
 * Troca, dentro de um texto, tudo o que PARECE segredo pelo marcador.
 *
 * Três famílias, e a ordem importa — é a mesma que a tela sempre aplicou:
 *
 * 1. **Por rótulo + forma**: `chave=valor`, `chave: valor`, `"chave":"valor"`,
 *    `Authorization: Bearer valor`. Um valor rotulado só é tratado como segredo
 *    se PARECER segredo — tem dígito ou é longo. Sem isso, "troca de token:
 *    invalid_client" virava "token=[oculto]" e a mensagem deixava de dizer o que
 *    aconteceu. O buraco que isso abre, dito: `senha=correcthorse` passa.
 *    Nenhum segredo de máquina tem essa forma; uma senha escolhida por gente tem.
 * 2. **Senha embutida em DSN** (`://usuario:senha@host`).
 * 3. **Por forma, sem rótulo**: `APP_USR-…`, `TG-…`, JWT e `sk-ant-…`.
 *
 * Não é criptografia nem garantia. Não esconde query string nem corta tamanho:
 * isso é decisão de TELA, e mora em `apps/web/lib/sanitize.ts`.
 */
export function redactSecretText(text: string, marker = "[REDACTED]"): string {
  let limpo = text
    .replace(LABELED_SECRET, (match: string, chave: string, _sep: string, valor: string) =>
      /\d/.test(valor) || valor.length >= 20 ? `${chave}=${marker}` : match,
    )
    .replace(DSN_CREDENTIALS, `://${marker}@`);

  for (const padrao of UNLABELED_SECRETS) {
    limpo = limpo.replace(padrao, marker);
  }

  return limpo;
}
