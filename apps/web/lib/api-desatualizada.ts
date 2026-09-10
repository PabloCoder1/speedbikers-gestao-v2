/**
 * "A API não conhece esta rota" — o diagnóstico que faltava (D-301).
 *
 * ---------------------------------------------------------------------------
 * POR QUE ISTO EXISTE
 * ---------------------------------------------------------------------------
 *
 * O deploy do Cloud Run é MANUAL (D-070). Uma tela nova chama uma rota nova, e
 * a `api` no ar pode ser de semanas atrás — o botão então recebe **404**, e a
 * tela dizia "Recurso não encontrado", que é a resposta literal do servidor e
 * a pergunta errada: manda procurar o recurso, quando o que falta é a versão.
 *
 * Medido em 2026-09-10, com o convite de usuário: a `api` em produção
 * respondia pelo commit `6baa641`, no ar desde 07/09, e o `HEAD` estava **110
 * commits** à frente — **5** deles tocando `apps/api` e **32** tocando `apps/api`
 * ou `packages/`, que ela empacota junto. A rota de convite entrou em `4ef8d18`,
 * três dias DEPOIS do que estava rodando. Nada estava quebrado; a feature
 * simplesmente não tinha sido implantada.
 *
 * ---------------------------------------------------------------------------
 * COMO ELE SABE
 * ---------------------------------------------------------------------------
 *
 * `GET /health` devolve o commit que está rodando (`APP_COMMIT`, D-070) — foi
 * criado exatamente para responder "o que está no ar?". Um 404 numa rota que
 * o cliente sabe existir é a pergunta; `/health` é a resposta.
 *
 * **Só roda no caminho de erro.** Nenhuma chamada extra no caminho feliz.
 *
 * E ele nunca AFIRMA o que não mediu: se `/health` não responde, ou responde
 * sem commit, a frase diz o que se sabe e para por aí.
 */

/** O que `/health` devolve; só o que interessa aqui. */
interface Saude {
  commit?: string | null;
  startedAt?: string | null;
}

/**
 * A frase para um 404 vindo da `api`.
 *
 * `apiUrl` entra no texto porque é o que a pessoa vai conferir a seguir — e
 * porque, com mais de um ambiente à mão, saber QUAL respondeu é metade do
 * diagnóstico.
 */
export async function explicar404(apiUrl: string): Promise<string> {
  const base = `A API em ${apiUrl} não conhece esta rota.`;
  const provavel =
    "O mais provável é que a versão no ar seja anterior a esta tela — o deploy do Cloud Run é manual.";

  let saude: Saude | null;

  try {
    const resposta = await fetch(`${apiUrl}/health`, { method: "GET" });

    saude = resposta.ok ? ((await resposta.json()) as Saude) : null;
  } catch {
    // Sem `/health` não há o que acrescentar — e inventar seria pior do que a
    // frase curta.
    saude = null;
  }

  const commit = typeof saude?.commit === "string" && saude.commit.length > 0 ? saude.commit : null;

  if (commit === null) {
    return `${base} ${provavel}`;
  }

  const desde = typeof saude?.startedAt === "string" ? formatarDesde(saude.startedAt) : null;

  return `${base} Ela está no commit ${commit}${desde === null ? "" : `, no ar desde ${desde}`}. ${provavel}`;
}

/** Data absoluta, curta. Duração aqui seria imprecisa e não ajuda mais. */
function formatarDesde(iso: string): string | null {
  const instante = Date.parse(iso);

  if (Number.isNaN(instante)) return null;

  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(instante);
}
