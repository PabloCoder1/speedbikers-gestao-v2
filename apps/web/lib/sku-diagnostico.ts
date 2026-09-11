import { RECONCILIATION_RESOURCE } from "./sync-health";
import type { AnuncioDoSku } from "./sku-listings";

/**
 * O diagnóstico de um SKU (D-317) — o que está certo, o que está errado, a
 * causa provável e o que fazer.
 *
 * ## Três níveis, e cada um com régua escrita
 *
 * O dono do produto pediu quatro (🟢🟡🟠🔴) e escolheu três com régua quando
 * soube que esta casa não tem escala de quatro. São os mesmos de
 * `sync-health.ts`: **ok**, **atenção**, **crítico**. A diferença entre "três
 * com régua" e "quatro sem" é a que este módulo inteiro protege — cada
 * verificação diz, em texto, a condição exata que a fez acender, e o que não
 * tem condição escrita **não vira selo**: vira linha em `semRegua`.
 *
 * A regra da casa por trás disso é D-148: "quanto é demais é decisão do ADMIN,
 * não constante do código". Por isso a dispersão de preço aparece como NÚMERO
 * e não como alerta — não há teto configurado em lugar nenhum, e inventar 10%
 * aqui seria exatamente a constante que aquela decisão proíbe.
 *
 * ## O que ele NÃO faz
 *
 * Não cria `actions`, não persiste veredito e não inventa score composto. As
 * ações que o sistema já detectou (venda anômala, reclamações recorrentes)
 * entram como estão, com a severidade e a recomendação que já têm — este
 * módulo é leitura sobre o que existe, não uma segunda máquina de diagnóstico.
 */
export type NivelDiagnostico = "ok" | "atencao" | "critico";

const ORDEM: Record<NivelDiagnostico, number> = { ok: 0, atencao: 1, critico: 2 };

export interface ProblemaDoSku {
  readonly chave: string;
  readonly titulo: string;
  readonly nivel: NivelDiagnostico;
  /** Conta e anúncio, quando o problema tem endereço. */
  readonly onde: string | null;
  readonly problema: string;
  readonly causa: string;
  readonly recomendacao: string;
  /** A condição exata que acendeu — é ela que separa veredito de palpite. */
  readonly regua: string;
}

export interface EstoqueInterno {
  readonly local: number;
  readonly reservado: number;
  readonly transito: number;
  readonly full: number;
  /** Saldo sentinela do ERP (D-127): não é contagem, então não se compara. */
  readonly virtual: boolean;
}

export interface AcaoAberta {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly recommendation: string | null;
  readonly mlbId: string | null;
}

export interface EntradaDoDiagnostico {
  readonly anuncios: readonly AnuncioDoSku[];
  readonly estoqueInterno: EstoqueInterno | null;
  readonly acoesAbertas: readonly AcaoAberta[];
  readonly agora: Date;
  /** Quando o escopo é UMA conta, o rótulo dela — muda o que dá para afirmar. */
  readonly contaEscopo: string | null;
}

export interface RetratoDePrecos {
  readonly menor: number;
  readonly maior: number;
  readonly media: number;
  /** (maior − menor) ÷ menor, em pontos percentuais. Fato, não veredito. */
  readonly dispersaoPct: number;
}

export interface DiagnosticoDoSku {
  /** `null` quando não havia nada julgável — sem anúncio, por exemplo. */
  readonly nivel: NivelDiagnostico | null;
  readonly anuncios: number;
  readonly contas: number;
  readonly ativos: number;
  readonly pausados: number;
  readonly outros: number;
  /** Soma do que os anúncios declaram no Mercado Livre. */
  readonly estoqueAnunciado: number;
  readonly precos: RetratoDePrecos | null;
  readonly problemas: readonly ProblemaDoSku[];
  /** O que não foi julgado, e por quê — a lista que impede o selo mentiroso. */
  readonly semRegua: readonly string[];
}

/*
  A CADÊNCIA DO CATÁLOGO vem de `sync-health.ts`, que a lê de
  `infra/cloud-scheduler.sh` — 360 minutos, o cron `0 *\/6 * * *`. O fator 2 é
  a mesma tolerância que a Saúde da Sincronização usa para "atrasando": uma
  janela perdida é ruído, duas são sinal. Nenhum número novo nasce aqui.
*/
const CATALOGO_CADENCIA_MIN = RECONCILIATION_RESOURCE.listings?.cadenceMin ?? 360;
const TOLERANCIA_JANELAS = 2;

function pior(a: NivelDiagnostico | null, b: NivelDiagnostico): NivelDiagnostico {
  if (a === null) return b;

  return ORDEM[b] > ORDEM[a] ? b : a;
}

function endereco(anuncio: AnuncioDoSku): string {
  return `${anuncio.account_label ?? "conta desconhecida"} · ${anuncio.item_id}`;
}

export function diagnosticarSku(entrada: EntradaDoDiagnostico): DiagnosticoDoSku {
  const { anuncios, estoqueInterno, acoesAbertas, agora } = entrada;

  const problemas: ProblemaDoSku[] = [];
  const semRegua: string[] = [];

  const ativos = anuncios.filter((a) => a.status === "active");
  const pausados = anuncios.filter((a) => a.status === "paused");
  const outros = anuncios.filter((a) => a.status !== null && a.status !== "active" && a.status !== "paused");
  const contas = new Set(anuncios.map((a) => a.ml_account_id)).size;

  const estoqueAnunciado = anuncios.reduce((total, a) => total + (a.available_quantity ?? 0), 0);

  /*
    1. ANÚNCIO ATIVO COM ZERO ANUNCIADO — crítico, e é o mais direto de todos:
    o anúncio está no ar e não pode vender. Não há limiar a configurar aqui,
    porque zero não é "pouco": é a impossibilidade da venda.
  */
  for (const anuncio of ativos) {
    if (anuncio.available_quantity !== 0) continue;

    problemas.push({
      chave: `ativo-sem-estoque:${anuncio.item_id}`,
      titulo: "Anúncio ativo sem estoque",
      nivel: "critico",
      onde: endereco(anuncio),
      problema: "O anúncio está ativo no Mercado Livre com 0 unidade disponível — ele aparece e não vende.",
      causa:
        "Ou o estoque acabou e o envio de reposição não saiu, ou a sincronização de estoque desta conta não chegou ao anúncio.",
      recomendacao: "Repor o estoque do anúncio ou pausá-lo até repor — anúncio ativo sem estoque queima exposição.",
      regua: "status = ativo e estoque anunciado = 0",
    });
  }

  /*
    2. PAUSADO COM ESTOQUE INTERNO — atenção. É a mesma classe que a Home já
    conta ("Anúncios pausados com estoque disponível"), e o motivo de ser
    ATENÇÃO e não crítico é que pausar pode ter sido deliberado.
  */
  const temEstoqueInterno =
    estoqueInterno !== null && !estoqueInterno.virtual && estoqueInterno.local + estoqueInterno.full > 0;

  if (temEstoqueInterno) {
    for (const anuncio of pausados) {
      problemas.push({
        chave: `pausado-com-estoque:${anuncio.item_id}`,
        titulo: "Anúncio pausado com estoque disponível",
        nivel: "atencao",
        onde: endereco(anuncio),
        problema: "O anúncio está pausado, e há saldo interno deste SKU para vender.",
        causa: "Pausa deliberada que ninguém desfez, ou pausa automática por falta de estoque que já foi reposto.",
        recomendacao: "Conferir se a pausa ainda faz sentido e reativar o anúncio.",
        regua: "status = pausado e (estoque local + Full) > 0",
      });
    }
  }

  /*
    3. ESTOQUE SEM VITRINE — crítico. Há produto e nenhum anúncio ativo: o
    saldo não tem por onde sair.

    A condição exige ao menos um anúncio COM ESTADO CONHECIDO. Um SKU cujo
    único anúncio nunca foi sincronizado não tem estado nenhum para julgar — e
    dizer "nenhum ativo" ali seria afirmar sobre o que não se leu, que é
    exatamente o que este módulo existe para não fazer.
  */
  const comEstado = anuncios.filter((a) => a.status !== null);

  if (temEstoqueInterno && comEstado.length > 0 && ativos.length === 0) {
    problemas.push({
      chave: "estoque-sem-vitrine",
      titulo: "Estoque sem anúncio ativo",
      nivel: "critico",
      onde: null,
      problema: "Há saldo interno deste SKU e nenhum anúncio ativo — o produto não está à venda em lugar nenhum.",
      causa: "Todos os anúncios foram pausados ou encerrados, e nenhum substituto entrou no ar.",
      recomendacao: "Reativar um anúncio ou criar um novo no Mercado Livre.",
      regua: "(estoque local + Full) > 0, ao menos um anúncio com estado lido, e nenhum deles ativo",
    });
  }

  /*
    4. CATÁLOGO VELHO — atenção, com a régua vinda da cadência real do job.
    Um anúncio cujo retrato tem mais de duas janelas de sincronização não
    descreve o presente, e todo o resto deste diagnóstico o lê como se
    descrevesse.
  */
  const limiteMs = CATALOGO_CADENCIA_MIN * TOLERANCIA_JANELAS * 60_000;

  for (const anuncio of anuncios) {
    if (anuncio.synced_at === null) continue;

    const idade = agora.getTime() - Date.parse(anuncio.synced_at);

    if (Number.isNaN(idade) || idade <= limiteMs) continue;

    problemas.push({
      chave: `catalogo-velho:${anuncio.item_id}`,
      titulo: "Retrato do anúncio desatualizado",
      nivel: "atencao",
      onde: endereco(anuncio),
      problema: `A última sincronização deste anúncio tem mais de ${String((CATALOGO_CADENCIA_MIN * TOLERANCIA_JANELAS) / 60)} horas — estado, preço e estoque mostrados aqui podem já não ser os do Mercado Livre.`,
      causa: "A sincronização do catálogo desta conta pode estar falhando ou a conta pode ter perdido a credencial.",
      recomendacao: "Conferir a conta em Sincronização e, se houver falha, reconectar a conta.",
      regua: `synced_at mais velho que ${String(TOLERANCIA_JANELAS)}× a cadência do catálogo (${String(CATALOGO_CADENCIA_MIN)} min)`,
    });
  }

  /*
    5. AS AÇÕES QUE O SISTEMA JÁ DETECTOU entram como estão. A severidade é a
    delas — `actions.severity` tem três valores e nenhum é "crítico" no
    sentido desta tela, então o mapa é explícito: alta vira crítico porque é o
    topo da escala de lá; média e baixa viram atenção. Nada é recalculado.
  */
  for (const acao of acoesAbertas) {
    const nivel: NivelDiagnostico = acao.severity === "alta" ? "critico" : "atencao";

    problemas.push({
      chave: `acao:${acao.id}`,
      titulo: "Ação aberta para este SKU",
      nivel,
      onde: acao.mlbId,
      problema: `O sistema detectou "${acao.kind}" e a ação continua aberta.`,
      causa: "A detecção é do próprio sistema — a evidência dela está na Central de Ações.",
      recomendacao: acao.recommendation ?? "Abrir a ação na Central de Ações e decidir.",
      regua: `ação com status aberto e severidade ${acao.severity}`,
    });
  }

  /*
    6. PREÇOS — FATO, NÃO VEREDITO. O dono pediu "sinalizar quando a diferença
    for muito grande", e "muito grande" é decisão de quem vende: não há teto
    configurado em lugar nenhum do esquema, e D-148 é explícita sobre não
    inventar a constante. O número aparece; o selo espera a régua.
  */
  const precosLidos = anuncios.map((a) => a.price).filter((p): p is number => p !== null);

  let precos: RetratoDePrecos | null = null;

  if (precosLidos.length > 0) {
    const menor = Math.min(...precosLidos);
    const maior = Math.max(...precosLidos);
    const media = precosLidos.reduce((total, p) => total + p, 0) / precosLidos.length;

    precos = {
      menor,
      maior,
      media: Math.round(media * 100) / 100,
      dispersaoPct: menor === 0 ? 0 : Math.round(((maior - menor) / menor) * 1000) / 10,
    };

    if (precosLidos.length > 1 && maior > menor) {
      semRegua.push(
        "Dispersão de preço entre os anúncios: o número está no bloco de preços, sem selo. Não há teto de dispersão configurado, e afirmar “alto” sem régua seria palpite com cara de veredito.",
      );
    }
  }

  /*
    7. O QUE NÃO DÁ PARA JULGAR, dito em voz alta. Cada linha aqui é uma
    pergunta do pedido que a fonte não responde — e dizer isso é o que impede
    a tela de responder errado.
  */
  if (estoqueInterno === null) {
    semRegua.push("Estoque interno não lido para este SKU — a comparação com o anunciado fica de fora.");
  } else if (estoqueInterno.virtual) {
    semRegua.push(
      "O saldo interno deste SKU é sentinela do ERP (D-127), não contagem: comparar com o anunciado produziria uma divergência inventada.",
    );
  }

  if (entrada.contaEscopo !== null) {
    semRegua.push(
      `O estoque interno é da ORGANIZAÇÃO, não de ${entrada.contaEscopo}: não existe saldo por conta em nenhuma tabela, então “divergência de estoque nesta conta” não é calculável.`,
    );
  }

  const semSincronizacao = anuncios.filter((a) => a.status === null);

  if (semSincronizacao.length > 0) {
    semRegua.push(
      `${String(semSincronizacao.length)} anúncio(s) vinculado(s) ainda sem sincronização: não há estado, preço nem estoque para julgar.`,
    );
  }

  let nivel: NivelDiagnostico | null = anuncios.length === 0 ? null : "ok";

  for (const problema of problemas) {
    nivel = pior(nivel, problema.nivel);
  }

  return {
    nivel,
    anuncios: anuncios.length,
    contas,
    ativos: ativos.length,
    pausados: pausados.length,
    outros: outros.length,
    estoqueAnunciado,
    precos,
    problemas,
    semRegua,
  };
}

/** Rótulo e tom do nível, na forma que a tela usa. */
export const NIVEL: Record<NivelDiagnostico, { rotulo: string; tom: "ok" | "atencao" | "perigo" }> = {
  ok: { rotulo: "Saudável", tom: "ok" },
  atencao: { rotulo: "Atenção", tom: "atencao" },
  critico: { rotulo: "Crítico", tom: "perigo" },
};

/**
 * A comparação de preço de UMA conta contra as demais (o "diagnóstico
 * comparativo" do pedido).
 *
 * `null` quando não há com o que comparar — uma conta só, ou nenhuma das
 * outras com preço lido. Comparar contra si mesmo devolveria 0% e pareceria
 * uma medição.
 */
export function compararPrecoDaConta(
  anuncios: readonly AnuncioDoSku[],
  mlAccountId: string,
): { daConta: number; dasOutras: number; diferencaPct: number } | null {
  const daConta = anuncios.filter((a) => a.ml_account_id === mlAccountId).map((a) => a.price);
  const dasOutras = anuncios.filter((a) => a.ml_account_id !== mlAccountId).map((a) => a.price);

  const validos = (lista: (number | null)[]): number[] => lista.filter((p): p is number => p !== null);

  const aqui = validos(daConta);
  const outras = validos(dasOutras);

  if (aqui.length === 0 || outras.length === 0) return null;

  const mediaAqui = aqui.reduce((t, p) => t + p, 0) / aqui.length;
  const mediaOutras = outras.reduce((t, p) => t + p, 0) / outras.length;

  return {
    daConta: Math.round(mediaAqui * 100) / 100,
    dasOutras: Math.round(mediaOutras * 100) / 100,
    diferencaPct: mediaOutras === 0 ? 0 : Math.round(((mediaAqui - mediaOutras) / mediaOutras) * 1000) / 10,
  };
}
