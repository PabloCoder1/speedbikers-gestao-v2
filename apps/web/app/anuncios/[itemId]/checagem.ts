import type { Tom } from "../../../components/tone";
import { formatCount } from "../../../lib/format";

/**
 * CHECAGEM DO ANÚNCIO — sete perguntas de sim ou não sobre fatos que a tela JÁ
 * leu, cada uma com o que fazer quando a resposta é ruim.
 *
 * **Não é a "Saúde do Anúncio" do frame**, que a tela recusou (competitividade
 * de preço e qualidade de foto não têm fonte). Aqui não há nota, peso nem
 * veredito sintetizado: cada linha é um fato medido e o critério dela vem
 * escrito. A contagem "N de M em ordem" é contagem de linhas, não índice.
 *
 * Pura e sem React, para o critério ser testável sem renderizar a página.
 */
export interface ItemDeChecagem {
  readonly chave: string;
  readonly titulo: string;
  readonly detalhe: string;
  readonly tom: Tom;
  readonly acao?: { readonly rotulo: string; readonly href: string };
}

/** Depois disto a leitura do anúncio é velha: o sync roda de 6 em 6 horas. */
export const SYNC_VELHO_HORAS = 12;

export interface FatosDoAnuncio {
  readonly itemId: string;
  readonly status: string;
  readonly disponivel: number;
  readonly skuId: string | null;
  readonly sku: string | null;
  readonly syncedAt: string;
  readonly agora: Date;
  /** `undefined` quando a aba não leu o Full; `null` é "sem snapshot". */
  readonly full: number | null | undefined;
  /** `null` quando o resumo não veio — a linha some em vez de chutar. */
  readonly resumo: { readonly unidades: number; readonly visitas: number; readonly diasObservados: number } | null;
  readonly janelaDias: number;
}

export function horasDesde(instante: string, agora: Date): number {
  return Math.max(0, (agora.getTime() - new Date(instante).getTime()) / 3_600_000);
}

/** "há 5 min", "há 3 h", "há 2 dias" — idade de uma leitura, não relógio. */
export function idadeRelativa(instante: string, agora: Date): string {
  const horas = horasDesde(instante, agora);

  if (horas < 1) {
    const minutos = Math.max(1, Math.round(horas * 60));

    return `há ${String(minutos)} min`;
  }

  if (horas < 48) {
    return `há ${String(Math.floor(horas))} h`;
  }

  return `há ${String(Math.floor(horas / 24))} dias`;
}

export function checarAnuncio(fatos: FatosDoAnuncio): ItemDeChecagem[] {
  const itens: ItemDeChecagem[] = [];

  itens.push(
    fatos.status === "active"
      ? { chave: "estado", titulo: "Anúncio ativo", detalhe: "Publicado e visível para compra no Mercado Livre.", tom: "ok" }
      : fatos.status === "paused"
        ? {
            chave: "estado",
            titulo: "Anúncio pausado",
            detalhe: "Não aparece nas buscas nem recebe venda enquanto estiver pausado.",
            tom: "atencao",
          }
        : {
            chave: "estado",
            titulo: "Anúncio fora do ar",
            detalhe: `Estado "${fatos.status}" no Mercado Livre — não vende neste estado.`,
            tom: "perigo",
          },
  );

  itens.push(
    fatos.disponivel > 0
      ? {
          chave: "estoque",
          titulo: "Com estoque no anúncio",
          detalhe: `${formatCount(fatos.disponivel)} unidade(s) disponíveis para venda.`,
          tom: "ok",
        }
      : {
          chave: "estoque",
          titulo: "Sem estoque no anúncio",
          detalhe: "Disponível zero no Mercado Livre: o anúncio não converte visita em venda.",
          tom: "perigo",
          acao: { rotulo: "Ver reposição", href: "/reposicao" },
        },
  );

  itens.push(
    fatos.skuId !== null
      ? {
          chave: "vinculo",
          titulo: "Vinculado a um SKU",
          detalhe: `Cada venda baixa o estoque de ${fatos.sku ?? "SKU"}.`,
          tom: "ok",
          acao: { rotulo: "Abrir SKU", href: `/skus/${fatos.skuId}` },
        }
      : {
          chave: "vinculo",
          titulo: "Sem vínculo de SKU",
          detalhe: "A venda deste anúncio não baixa estoque nem entra no custo e na margem.",
          tom: "atencao",
          acao: { rotulo: "Vincular", href: "/vinculacoes" },
        },
  );

  if (fatos.full !== undefined) {
    itens.push(
      fatos.full === null
        ? {
            chave: "full",
            titulo: "Sem leitura de Full",
            detalhe: "Nenhum snapshot nos últimos 3 dias — fora do Full, ou a captura não o alcançou.",
            tom: "neutro",
          }
        : fatos.full > 0
          ? {
              chave: "full",
              titulo: "Estoque no Full",
              detalhe: `${formatCount(fatos.full)} unidade(s) guardadas pelo Mercado Livre.`,
              tom: "ok",
            }
          : {
              chave: "full",
              titulo: "Full zerado",
              detalhe: "O snapshot mais recente mostra saldo zero no Full para este anúncio.",
              tom: "atencao",
              acao: { rotulo: "Central Full", href: "/full" },
            },
    );
  }

  if (fatos.resumo !== null) {
    const { unidades, visitas, diasObservados } = fatos.resumo;

    itens.push(
      diasObservados > 0
        ? {
            chave: "visitas",
            titulo: "Visitas coletadas",
            detalhe: `${formatCount(visitas)} visita(s) em ${String(diasObservados)} de ${String(fatos.janelaDias)} dias com coleta.`,
            tom: "ok",
          }
        : {
            chave: "visitas",
            titulo: "Sem coleta de visitas",
            detalhe: "A varredura ainda não alcançou este anúncio no período — ausência de coleta, não visita zero.",
            tom: "neutro",
          },
    );

    itens.push(
      unidades > 0
        ? {
            chave: "venda",
            titulo: "Vendendo",
            detalhe: `${formatCount(unidades)} unidade(s) vendidas nos últimos ${String(fatos.janelaDias)} dias.`,
            tom: "ok",
          }
        : diasObservados > 0 && visitas > 0
          ? {
              chave: "venda",
              titulo: "Recebe visita e não vende",
              detalhe: `${formatCount(visitas)} visita(s) e nenhuma venda registrada em ${String(fatos.janelaDias)} dias.`,
              tom: "atencao",
              acao: { rotulo: "Ver preço", href: `/anuncios/${fatos.itemId}?aba=preco` },
            }
          : {
              chave: "venda",
              titulo: "Sem venda no período",
              detalhe: `Nenhum dia com venda registrada nos últimos ${String(fatos.janelaDias)} dias.`,
              tom: "atencao",
            },
    );
  }

  const horas = horasDesde(fatos.syncedAt, fatos.agora);

  itens.push(
    horas <= SYNC_VELHO_HORAS
      ? {
          chave: "sync",
          titulo: "Leitura recente",
          detalhe: `Sincronizado ${idadeRelativa(fatos.syncedAt, fatos.agora)} — preço e estoque são desta leitura.`,
          tom: "ok",
        }
      : {
          chave: "sync",
          titulo: "Leitura antiga",
          detalhe: `Última sincronização ${idadeRelativa(fatos.syncedAt, fatos.agora)}: preço e estoque podem ter mudado.`,
          tom: "atencao",
          acao: { rotulo: "Sincronização", href: "/sincronizacao" },
        },
  );

  // O que pede trabalho sobe: perigo, atenção, sem leitura, e o que está em
  // ordem por último. `sort` é estável, então a ordem dentro do tom se mantém.
  const peso: Record<Tom, number> = { perigo: 0, atencao: 1, neutro: 2, info: 2, ok: 3 };

  return itens.sort((a, b) => peso[a.tom] - peso[b.tom]);
}
