import { previousBusinessDateRange, shiftBusinessDate } from "@sb/domain";

import type { PeriodRange } from "./period";

/**
 * Os períodos da Central do negócio (D-394) e a janela de comparação de cada um.
 *
 * **Por que não reaproveitar `lib/period.ts`:** lá os presets são "últimos N
 * dias ATÉ HOJE", e comparar isso com os N dias anteriores põe um dia em
 * andamento contra um dia inteiro — às 10h, os "últimos 7 dias" já nascem ~10%
 * abaixo da semana anterior sem que nada tenha piorado. Uma central que pinta
 * variação de vermelho não pode herdar esse viés. Aqui as janelas móveis e o
 * mês atual terminam ONTEM (dias completos), e o dia de hoje tem preset
 * próprio, marcado como em andamento. As outras telas não mudam.
 *
 * A regra de cada janela anterior está em `docs/METRICS.md` 5I
 * (`comparacao_periodo_anterior`).
 */

export type PresetCentral = "hoje" | "ontem" | "7d" | "15d" | "30d" | "mes" | "mes-anterior";

export const PRESETS_CENTRAL: readonly { readonly id: PresetCentral; readonly label: string }[] = [
  { id: "hoje", label: "Hoje" },
  { id: "ontem", label: "Ontem" },
  { id: "7d", label: "Últimos 7 dias" },
  { id: "15d", label: "Últimos 15 dias" },
  { id: "30d", label: "Últimos 30 dias" },
  { id: "mes", label: "Mês atual" },
  { id: "mes-anterior", label: "Mês anterior" },
];

export const PRESET_CENTRAL_PADRAO: PresetCentral = "30d";

export interface PeriodoCentral {
  /** `null` = período personalizado. */
  readonly preset: PresetCentral | null;
  readonly atual: PeriodRange;
  readonly anterior: PeriodRange;
  readonly rotulo: string;
  /** O período atual inclui hoje: volumes ainda crescem e não podem ser julgados contra dias inteiros. */
  readonly emAndamento: boolean;
  /** O personalizado pedido era inválido e caiu no padrão. */
  readonly invalido: boolean;
}

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

const DIAS_MOVEIS: Readonly<Record<"7d" | "15d" | "30d", number>> = { "7d": 7, "15d": 15, "30d": 30 };

function primeiroDoMes(data: string): string {
  return `${data.slice(0, 8)}01`;
}

/** O mês anterior inteiro ao mês de `data`. */
function mesAnteriorA(data: string): PeriodRange {
  const ultimo = shiftBusinessDate(primeiroDoMes(data), -1);

  return { from: primeiroDoMes(ultimo), to: ultimo };
}

/**
 * Os mesmos dias do mês anterior: 1 a N contra 1 a N, limitado ao fim do mês
 * anterior (1–31/03 compara com 1–28/02, e o rótulo mostra as duas pontas).
 */
function mesmosDiasDoMesAnterior(atual: PeriodRange): PeriodRange {
  const mes = mesAnteriorA(atual.from);
  const dias = Number(atual.to.slice(8, 10));
  const fim = shiftBusinessDate(mes.from, dias - 1);

  return { from: mes.from, to: fim > mes.to ? mes.to : fim };
}

function rotuloDoPreset(preset: PresetCentral): string {
  return PRESETS_CENTRAL.find((p) => p.id === preset)?.label ?? preset;
}

function doPreset(preset: PresetCentral, hoje: string): PeriodoCentral {
  const ontem = shiftBusinessDate(hoje, -1);
  const base = { preset, rotulo: rotuloDoPreset(preset), invalido: false };

  switch (preset) {
    case "hoje":
      return { ...base, atual: { from: hoje, to: hoje }, anterior: { from: ontem, to: ontem }, emAndamento: true };

    case "ontem": {
      const anteontem = shiftBusinessDate(hoje, -2);

      return { ...base, atual: { from: ontem, to: ontem }, anterior: { from: anteontem, to: anteontem }, emAndamento: false };
    }

    case "7d":
    case "15d":
    case "30d": {
      const atual = { from: shiftBusinessDate(ontem, -(DIAS_MOVEIS[preset] - 1)), to: ontem };

      return { ...base, atual, anterior: previousBusinessDateRange(atual.from, atual.to), emAndamento: false };
    }

    case "mes": {
      // No dia 1 o mês ainda não tem dia completo: o "mês atual" é o próprio
      // dia, em andamento, contra o dia 1 do mês anterior.
      if (hoje === primeiroDoMes(hoje)) {
        const atual = { from: hoje, to: hoje };

        return { ...base, rotulo: "Mês atual (só hoje)", atual, anterior: mesmosDiasDoMesAnterior(atual), emAndamento: true };
      }

      const atual = { from: primeiroDoMes(hoje), to: ontem };

      return { ...base, atual, anterior: mesmosDiasDoMesAnterior(atual), emAndamento: false };
    }

    case "mes-anterior": {
      const atual = mesAnteriorA(hoje);

      return { ...base, atual, anterior: mesAnteriorA(atual.from), emAndamento: false };
    }
  }
}

function ehPreset(valor: unknown): valor is PresetCentral {
  return typeof valor === "string" && PRESETS_CENTRAL.some((p) => p.id === valor);
}

/**
 * Lê `?p=` (preset) ou `?from=&to=` (personalizado) da URL.
 *
 * O personalizado vence o preset quando os dois vêm. Data fora do formato,
 * início depois do fim ou início no futuro cai no padrão com `invalido`, e a
 * tela avisa — nunca um período silenciosamente diferente do pedido. O fim no
 * futuro é cortado em hoje: não há venda amanhã para comparar.
 */
export function resolverPeriodoCentral(
  query: Readonly<Record<string, string | string[] | undefined>>,
  hoje: string,
): PeriodoCentral {
  const de = typeof query.from === "string" ? query.from : null;
  const ate = typeof query.to === "string" ? query.to : null;

  if (de !== null || ate !== null) {
    if (de !== null && ate !== null && DATA_ISO.test(de) && DATA_ISO.test(ate) && de <= ate && de <= hoje) {
      const atual = { from: de, to: ate > hoje ? hoje : ate };

      return {
        preset: null,
        atual,
        anterior: previousBusinessDateRange(atual.from, atual.to),
        rotulo: "Período personalizado",
        emAndamento: atual.to === hoje,
        invalido: false,
      };
    }

    return { ...doPreset(PRESET_CENTRAL_PADRAO, hoje), invalido: true };
  }

  return doPreset(ehPreset(query.p) ? query.p : PRESET_CENTRAL_PADRAO, hoje);
}
