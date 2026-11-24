/**
 * "Esqueci a senha" por conta própria (D-863) — as decisões que a tela de
 * entrada não toma sozinha.
 *
 * Até aqui só quem administra devolvia o acesso, gerando um novo link em
 * `/usuarios` (D-296, D-302): o Auth não tinha SMTP de verdade. O pedido por
 * e-mail usa o MESMO fim de caminho — o link volta para `/login` com
 * `type=recovery` no fragmento, e a tela de criar a nova senha já existe.
 *
 * O que fica aqui é o que se testa sem navegador.
 */

/**
 * O botão só aparece quando o Auth entrega e-mail de verdade. Ligado por
 * `RECUPERACAO_SENHA_POR_EMAIL=1` no servidor da `web`: sem SMTP real (a VM
 * de produção nasceu com o capturador de testes), o pedido "dá certo" e o
 * e-mail não chega a ninguém — pior do que não oferecer.
 */
export function recuperacaoPorEmailLigada(valor: string | undefined): boolean {
  return valor?.trim() === "1";
}

/**
 * Para onde o link do e-mail devolve a pessoa. A tela de entrada, e não uma
 * rota nova: o fragmento com a sessão já é lido ali (`invite-hash.ts`), e uma
 * rota nova precisaria entrar na lista de redirecionamentos do Auth, que vive
 * fora do repositório.
 */
export function linkDeRetorno(origem: string): string {
  return `${origem.replace(/\/+$/u, "")}/login`;
}

/** O que a tela mostra depois do pedido. */
export type DesfechoDoPedido = { kind: "enviado" } | { kind: "falha"; mensagem: string };

/**
 * O desfecho do pedido de link.
 *
 * **Endereço desconhecido também é "enviado".** O Auth responde sucesso para
 * e-mail que não existe, e a tela não pode desfazer isso: dizer "este e-mail
 * não tem acesso" entregaria a quem tenta adivinhar quais endereços valem — a
 * mesma razão do "E-mail ou senha incorretos." da entrada.
 *
 * A única falha com nome é o limite de envios, porque ela pede uma ação
 * diferente da pessoa: esperar, e não tentar de novo agora.
 */
export function desfechoDoPedido(
  falha: { status?: number | undefined; code?: string | undefined } | null,
): DesfechoDoPedido {
  if (falha === null) return { kind: "enviado" };

  if (falha.status === 429 || falha.code === "over_email_send_rate_limit" || falha.code === "over_request_rate_limit") {
    return {
      kind: "falha",
      mensagem: "Muitos pedidos de link em pouco tempo. Espere alguns minutos e peça de novo.",
    };
  }

  return {
    kind: "falha",
    mensagem: "Não foi possível pedir o link agora. Tente de novo em alguns minutos.",
  };
}
