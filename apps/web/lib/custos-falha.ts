/**
 * Falha das ações de linha de `/central/custos` (marcar paga, cancelar, remover).
 *
 * Elas são `<form action>` sem estado de retorno. Até aqui, o erro do banco era
 * descartado, e a linha voltava igual, sem aviso nenhum. Isso acontecia, por
 * exemplo, quando a trava do mês fechado (20261126235000) recusava a mudança.
 * Agora a ação devolve a tela com um código na URL, e a tela diz o que houve.
 *
 * A URL carrega só um código de uma lista fixa e o mês no formato MM/AAAA, nunca
 * o texto do banco. Assim, um link montado à mão não põe na tela uma frase
 * qualquer.
 */

export type Falha =
  | { readonly tipo: "mes-fechado"; readonly mes: string | null }
  | { readonly tipo: "permissao" }
  | { readonly tipo: "nao-alterada" }
  | { readonly tipo: "erro" };

interface ErroDoBanco {
  readonly message: string;
  readonly code?: string;
}

const MES = /^(0[1-9]|1[0-2])\/\d{4}$/;
const TIPOS = new Set(["mes-fechado", "permissao", "nao-alterada", "erro"]);

/**
 * Lê o resultado de um update ou delete feito com `.select("id")`.
 * `linhas` é quantas linhas o banco devolveu. Zero sem erro quer dizer que a RLS
 * filtrou a linha ou que ela já não existia.
 */
export function falhaDaAcao(error: ErroDoBanco | null, linhas: number | null): Falha | null {
  if (error !== null) {
    if (error.message.includes("está fechada")) {
      const mes = /(\d{2}\/\d{4})/.exec(error.message)?.[1] ?? null;
      return { tipo: "mes-fechado", mes: mes !== null && MES.test(mes) ? mes : null };
    }
    if (error.code === "42501") return { tipo: "permissao" };
    return { tipo: "erro" };
  }
  if (linhas === null || linhas === 0) return { tipo: "nao-alterada" };
  return null;
}

/**
 * Para onde a ação manda de volta: a mesma consulta da tela, sem a falha
 * anterior e com a nova, se houver. Devolve `null` quando não precisa
 * redirecionar, isto é, sem falha nova e sem falha antiga na URL.
 */
export function destinoDepoisDaAcao(referer: string | null, falha: Falha | null): string | null {
  const base = "/central/custos";
  let params = new URLSearchParams();
  if (referer !== null) {
    try {
      const url = new URL(referer);
      if (url.pathname === base) params = new URLSearchParams(url.search);
    } catch {
      // referer inválido: volta para a tela sem filtros
    }
  }
  const tinhaFalha = params.has("falha");
  params.delete("falha");
  params.delete("mes");

  if (falha === null && !tinhaFalha) return null;
  if (falha !== null) {
    params.set("falha", falha.tipo);
    if (falha.tipo === "mes-fechado" && falha.mes !== null) params.set("mes", falha.mes);
  }
  const consulta = params.toString();
  return consulta === "" ? base : `${base}?${consulta}`;
}

/** A frase da tela para a falha que veio na URL, ou `null` se não há falha conhecida. */
export function mensagemDaFalha(consulta: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const tipo = consulta.falha;
  if (typeof tipo !== "string" || !TIPOS.has(tipo)) return null;

  if (tipo === "mes-fechado") {
    const mes = consulta.mes;
    const qual = typeof mes === "string" && MES.test(mes) ? `A competência ${mes} está fechada` : "O mês está fechado";
    return `${qual}: nada foi alterado. Reabra o mês no fechamento mensal para mexer nesta despesa.`;
  }
  if (tipo === "permissao") return "Sem permissão: só ADMIN e GESTOR alteram custos e entidades fiscais. Nada foi alterado.";
  if (tipo === "nao-alterada") return "Nada foi alterado: o registro já não existe ou não pertence à sua organização. Atualize a página.";
  return "O banco recusou a alteração e nada mudou. Tente de novo; se continuar, avise o suporte.";
}
