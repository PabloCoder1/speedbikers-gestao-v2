/**
 * O que o link de convite deixa na URL — lido como dado, não como sessão
 * (D-302).
 *
 * ---------------------------------------------------------------------------
 * O QUE FOI MEDIDO
 * ---------------------------------------------------------------------------
 *
 * O convite de D-296 devolve um link do próprio Supabase
 * (`/auth/v1/verify?token=…&type=invite&redirect_to=…`). Seguindo ele, em
 * 2026-09-10, o navegador chegou em:
 *
 *   http://127.0.0.1:3000/login?next=%2F#access_token=eyJ…&refresh_token=…&type=invite
 *
 * Três fatos dessa medição decidem este módulo:
 *
 * 1. a sessão vem no **fragmento**, que NUNCA chega ao servidor — por isso o
 *    proxy não viu cookie nenhum e mandou a pessoa para `/login`;
 * 2. o fragmento **sobrevive ao redirect** do proxy, então quem o lê é a tela
 *    de entrada, e não uma rota nova (que ainda precisaria estar na lista de
 *    URLs permitidas do projeto Supabase, configuração que vive fora do
 *    repositório);
 * 3. quem foi convidado **não tem senha** — ninguém a definiu, nem o convite
 *    nem quem convidou. Sem uma tela para defini-la, o link levava ao
 *    formulário de entrada e parava ali: token válido na URL, nenhum campo
 *    para usá-lo.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ISTO É UM MÓDULO, E NÃO TRÊS LINHAS NA TELA
 * ---------------------------------------------------------------------------
 *
 * Porque o que ele decide é de SEGURANÇA, e coisa de segurança se testa:
 * `magiclink` também chega por fragmento e também traz sessão — mas ele
 * ENTRA direto, sem pedir senha. Aceitar qualquer `type` aqui transformaria a
 * tela de "defina sua senha" numa tela que aparece para quem já entrou.
 * A lista é fechada, e há caso reprovando cada tipo de fora dela.
 */

export type ConviteNaUrl =
  | {
      kind: "sessao";
      accessToken: string;
      refreshToken: string;
      /** `invite` é o convite de D-296; `recovery` é o "esqueci a senha" do dia
       *  em que ele existir. Os dois terminam no mesmo lugar: definir senha. */
      tipo: "invite" | "recovery";
    }
  /** O link venceu ou já foi usado. O Supabase devolve isso no MESMO fragmento. */
  | { kind: "expirado"; descricao: string }
  | null;

/** Os únicos tipos que levam à tela de definir senha. */
const TIPOS = new Set(["invite", "recovery"]);

/**
 * Lê o fragmento. Recebe a string (`location.hash`) em vez de ler `window`:
 * função pura testa sem navegador, e o único lugar que conhece o `window` é a
 * tela.
 */
export function lerConviteDaUrl(hash: string): ConviteNaUrl {
  const cru = hash.startsWith("#") ? hash.slice(1) : hash;

  if (cru === "") return null;

  const params = new URLSearchParams(cru);

  /*
    A RECUSA VEM PRIMEIRO. Link vencido chega como
    `error=access_denied&error_code=otp_expired`, sem token nenhum — e sem este
    ramo a tela mostraria o formulário de entrada como se nada tivesse
    acontecido, deixando a pessoa tentar uma senha que ela nunca definiu.
  */
  const erro = params.get("error");

  if (erro !== null && erro !== "") {
    const descricao = params.get("error_description");

    return {
      kind: "expirado",
      // O texto do Supabase vem com `+` no lugar do espaço em alguns casos;
      // `URLSearchParams` já desfaz isso. Se vier vazio, a tela tem a própria
      // frase — inventar tradução aqui seria uma segunda fonte da mesma coisa.
      descricao: descricao ?? "",
    };
  }

  const accessToken = params.get("access_token") ?? "";
  const refreshToken = params.get("refresh_token") ?? "";
  const tipo = params.get("type") ?? "";

  // Os três juntos, ou nada: meia sessão não se usa, e um `type` fora da lista
  // é um fluxo que esta tela não atende.
  if (accessToken === "" || refreshToken === "" || !TIPOS.has(tipo)) return null;

  return { kind: "sessao", accessToken, refreshToken, tipo: tipo as "invite" | "recovery" };
}
