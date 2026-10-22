/**
 * O que o botão "Conectar loja do TikTok Shop" diz para cada resposta da api que
 * não é o link (`POST /v1/tiktok-shop/connect`, C-86; a tela é a D-652).
 *
 * O 503 `not_configured` não é falha: é o TikTok ainda desligado no servidor
 * (sem as variáveis do app), e o aviso sai sem o vermelho de erro. O 401 e o 403
 * são de sessão e de papel; o 409 `rejected` é a autorização que não pôde
 * começar. O texto é da tela, e não o `message` da api: ele é técnico e em
 * minúscula ("não foi possível iniciar a autorização").
 */
export interface AvisoDaConexao {
  readonly tom: "erro" | "neutro";
  readonly texto: string;
}

export function avisoDaConexaoTiktok(status: number): AvisoDaConexao {
  if (status === 503) return { tom: "neutro", texto: "O TikTok Shop ainda não está disponível." };
  if (status === 401) return { tom: "erro", texto: "Sua sessão expirou. Entre de novo." };
  if (status === 403) return { tom: "erro", texto: "Só um administrador conecta a loja do TikTok Shop." };
  if (status === 409) return { tom: "erro", texto: "O TikTok Shop não deixou a autorização começar. Tente de novo." };

  return { tom: "erro", texto: "Não foi possível iniciar a conexão." };
}
