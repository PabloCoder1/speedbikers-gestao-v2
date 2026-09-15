import type { AdminClient } from "@sb/db";

/**
 * Diretório das contas do Mercado Livre, em memória (D-346).
 *
 * O webhook consultava `ml_accounts` no Postgres a cada notificação para
 * saber QUAL conta é dona do `seller_id`. Fora de pico isso custa ~50 ms; na
 * rajada de 14/09, 07:50 UTC — 110 notificações no mesmo segundo —, custou p95
 * de 2,8 s e explicou o ACK sozinho (D-345). E tirar a consulta de só parte das
 * notificações esfriou a conexão das outras (D-340).
 *
 * As contas são quatro e mudam por ato humano (conectar uma conta). Então a
 * tabela inteira é carregada numa consulta e servida da memória:
 *
 * - **uma carga em voo por vez** — a primeira rajada não dispara cem cargas;
 * - **prazo de 5 minutos** — depois dele, a próxima consulta recarrega;
 * - **seller desconhecido recarrega, no máximo a cada 30 s** — uma conta
 *   recém-conectada aparece sem esperar o prazo, e uma enxurrada de seller
 *   estranho não vira enxurrada de consulta;
 * - **falha na recarga com contas em memória serve as antigas** e tenta de
 *   novo em 30 s; sem nada em memória, rejeita, e o webhook responde como
 *   "conta desconhecida" — o mesmo que fazia quando a consulta falhava.
 */

export interface AccountRef {
  id: string;
  organization_id: string;
  slug: string;
}

export interface AccountDirectory {
  /** A conta dona do `seller_id`, ou `null`. Rejeita só quando não há carga nenhuma para responder. */
  resolve: (sellerId: number) => Promise<AccountRef | null>;
}

export interface AccountDirectoryOptions {
  load: () => Promise<Map<number, AccountRef>>;
  ttlMs?: number;
  unknownSellerReloadMinMs?: number;
  /** Antecipar a recarga em tráfego conhecido, sem ampliar o TTL. */
  refreshAheadMs?: number;
  /** Idade máxima para usar um diretório durante indisponibilidade do banco. */
  maxAgeMs?: number;
  /** Relógio em ms; injetável para o teste controlar prazo e intervalo. */
  now?: () => number;
}

export const ACCOUNT_DIRECTORY_TTL_MS = 5 * 60_000;
export const UNKNOWN_SELLER_RELOAD_MIN_MS = 30_000;

export function createAccountDirectory(options: AccountDirectoryOptions): AccountDirectory {
  const ttlMs = options.ttlMs ?? ACCOUNT_DIRECTORY_TTL_MS;
  const recargaMinMs = options.unknownSellerReloadMinMs ?? UNKNOWN_SELLER_RELOAD_MIN_MS;
  const agora = options.now ?? (() => Date.now());
  const refreshAheadMs = options.refreshAheadMs ?? Math.min(60_000, ttlMs / 5);
  const maxAgeMs = options.maxAgeMs ?? ttlMs + recargaMinMs;

  let contas: Map<number, AccountRef> | null = null;
  let carregadoEm = Number.NEGATIVE_INFINITY;
  let tentadoEm = Number.NEGATIVE_INFINITY;
  let emVoo: Promise<Map<number, AccountRef>> | null = null;

  function recarregar(): Promise<Map<number, AccountRef>> {
    if (emVoo !== null) {
      return emVoo;
    }

    tentadoEm = agora();
    const carga = options.load().then(
      (novas) => {
        contas = novas;
        carregadoEm = agora();

        return novas;
      },
      (erro: unknown) => {
        if (contas === null || agora() - carregadoEm >= maxAgeMs) {
          throw erro;
        }

        // Serve as antigas e tenta de novo depois do intervalo mínimo, não do
        // prazo inteiro: um banco que voltou precisa ser visto logo.
        return contas;
      },
    );

    emVoo = carga.finally(() => {
      emVoo = null;
    });

    return emVoo;
  }

  return {
    resolve: async (sellerId) => {
      let mapa = contas;
      const idade = agora() - carregadoEm;
      const podeRecarregar = agora() - tentadoEm >= recargaMinMs;

      if (mapa === null || idade >= maxAgeMs || (idade >= ttlMs && podeRecarregar)) {
        mapa = await recarregar();
      } else if (idade >= ttlMs - refreshAheadMs && podeRecarregar && mapa.has(sellerId)) {
        // A falha é observada na próxima leitura; nunca rejeição sem consumidor.
        void recarregar().catch(() => undefined);
      }

      const conta = mapa.get(sellerId);

      if (conta !== undefined) {
        return conta;
      }

      if (agora() - tentadoEm < recargaMinMs) {
        return null;
      }

      return (await recarregar()).get(sellerId) ?? null;
    },
  };
}

/**
 * A tabela inteira numa consulta. `seller_id` nulo é conta sem OAuth concluído
 * — nenhuma notificação a alcança. Seller repetido (a unicidade é por
 * organização) fica FORA do mapa: a consulta antiga, com `.maybeSingle()`,
 * falhava nesse caso e o webhook respondia "conta desconhecida", e o resultado
 * continua o mesmo.
 */
export async function loadAccountsFromDb(db: AdminClient): Promise<Map<number, AccountRef>> {
  const result = await db.from("ml_accounts").select("id, organization_id, slug, seller_id");

  if (result.error !== null) {
    throw new Error(`falha ao carregar ml_accounts: ${result.error.message}`);
  }

  const contas = new Map<number, AccountRef>();
  const repetidos = new Set<number>();

  for (const linha of result.data) {
    if (linha.seller_id === null) {
      continue;
    }

    const sellerId = linha.seller_id;

    if (contas.has(sellerId) || repetidos.has(sellerId)) {
      contas.delete(sellerId);
      repetidos.add(sellerId);
      continue;
    }

    contas.set(sellerId, { id: linha.id, organization_id: linha.organization_id, slug: linha.slug });
  }

  return contas;
}
