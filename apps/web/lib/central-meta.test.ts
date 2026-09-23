import { describe, expect, it } from "vitest";

import { lerMetaDoMes, ritmoDaMeta, situacaoDaMeta, type MetaDoMes } from "./central-meta";

/**
 * A resposta real de `get_meta_do_mes` no Dev (ensaio de 23/09 numa transação
 * desfeita): setembro, visto de 14/09, meta de teste de R$ 2,8 milhões.
 */
const RESPOSTA = {
  fim: "2026-09-30",
  mes: "2026-09-01",
  hoje: "2026-09-14",
  meta: 2800000,
  faltam: 1489466.61,
  ritmos: { sete: 96493.54, catorze: 98416.15, vinte_oito: 101043.91 },
  fatores: [
    { fator: 1.139, dia_semana: 1 },
    { fator: 1.13, dia_semana: 2 },
    { fator: 1.173, dia_semana: 3 },
    { fator: 1.075, dia_semana: 4 },
    { fator: 0.95, dia_semana: 5 },
    { fator: 0.821, dia_semana: 6 },
    { fator: 0.713, dia_semana: 7 },
  ],
  projecao: { ritmo: 3016840.06, otimista: 3016840.06, conservador: 2937474.54 },
  situacao: "em_curso",
  realizado: 1310533.39,
  atingimento: 0.468,
  dias_no_mes: 30,
  ano_anterior: {
    crescimento: -0.0326,
    receita_mes: 2654242.13,
    projecao_sazonal: 2567823.25,
    receita_ate_mesmo_dia: 1296699.42,
  },
  media_diaria: 96498.5,
  dias_completos: 13,
  dias_restantes: 17,
  dias_sem_venda: 0,
  perfil_semanal: true,
  realizado_hoje: 56052.92,
  diferenca_ritmo: 66087.63,
  inicio_historico: "2025-08-21",
  aumento_necessario: -0.0579,
  esperado_ate_ontem: 1188392.84,
  realizado_ate_ontem: 1254480.47,
  meta_diaria_necessaria: 90912.91,
};

function meta(parcial: Partial<MetaDoMes> = {}): MetaDoMes {
  const lida = lerMetaDoMes(RESPOSTA);

  if (lida === null) throw new Error("fixture fora do contrato");

  return { ...lida, ...parcial };
}

function legivel(texto: string): string {
  return texto.replaceAll(String.fromCharCode(160), " ");
}

describe("lerMetaDoMes", () => {
  it("lê a resposta real inteira", () => {
    const m = lerMetaDoMes(RESPOSTA);

    expect(m?.situacao).toBe("em_curso");
    expect(m?.projecao).toEqual({ ritmo: 3016840.06, otimista: 3016840.06, conservador: 2937474.54 });
    expect(m?.fatores).toHaveLength(7);
    expect(m?.ano_anterior?.projecao_sazonal).toBe(2567823.25);
  });

  it("aceita projeção e ano anterior nulos, e recusa campo ausente ou fora do formato", () => {
    expect(lerMetaDoMes({ ...RESPOSTA, projecao: null, ano_anterior: null })?.projecao).toBeNull();

    const semMedia: Record<string, unknown> = { ...RESPOSTA };

    delete semMedia.media_diaria;

    expect(lerMetaDoMes(semMedia)).toBeNull();
    expect(lerMetaDoMes({ ...RESPOSTA, situacao: "talvez" })).toBeNull();
    expect(lerMetaDoMes({ ...RESPOSTA, meta: "muita" })).toBeNull();
    expect(lerMetaDoMes({ ...RESPOSTA, projecao: { ritmo: 1 } })).toBeNull();
    expect(lerMetaDoMes(null)).toBeNull();
  });
});

describe("situacaoDaMeta", () => {
  it("no caminho quando o ritmo atual fecha acima da meta", () => {
    const s = situacaoDaMeta(meta());

    expect(s.tom).toBe("ok");
    expect(legivel(s.frase)).toBe("No ritmo atual o mês fecha em R$ 3.016.840,06, R$ 216.840,06 acima da meta.");
  });

  it("em risco quando só o otimista alcança; improvável quando nem ele", () => {
    expect(situacaoDaMeta(meta({ meta: 3_000_000, projecao: { ritmo: 2_950_000, conservador: 2_900_000, otimista: 3_010_000 } })).tom).toBe(
      "atencao",
    );
    expect(situacaoDaMeta(meta({ meta: 3_500_000 })).rotulo).toBe("meta improvável");
  });

  it("sem meta, a projeção continua dita", () => {
    const s = situacaoDaMeta(meta({ meta: null }));

    expect(s.tom).toBe("info");
    expect(legivel(s.frase)).toContain("setembro de 2026 não tem meta cadastrada; no ritmo atual o mês fecha em R$ 3.016.840,06");
  });

  it("mês encerrado: atingida ou não pelo realizado", () => {
    expect(situacaoDaMeta(meta({ situacao: "encerrado", realizado: 2_900_000, atingimento: 1.0357 })).rotulo).toBe("meta atingida");
    expect(situacaoDaMeta(meta({ situacao: "encerrado", realizado: 2_700_000, atingimento: 0.9643 })).tom).toBe("perigo");
  });

  it("sem projeção (histórico curto), julga pelo ritmo contra o esperado", () => {
    expect(situacaoDaMeta(meta({ projecao: null })).rotulo).toBe("acima do ritmo");
    expect(situacaoDaMeta(meta({ projecao: null, diferenca_ritmo: -200_000 })).tom).toBe("perigo");
  });
});

describe("ritmoDaMeta", () => {
  it("acima, levemente abaixo (atenção) e muito abaixo (perigo) do esperado", () => {
    expect(legivel(ritmoDaMeta(meta())?.texto ?? "")).toBe("R$ 66.087,63 acima do ritmo necessário");
    expect(ritmoDaMeta(meta({ diferenca_ritmo: -50_000 }))?.tom).toBe("atencao");
    expect(ritmoDaMeta(meta({ diferenca_ritmo: -100_000 }))?.tom).toBe("perigo");
  });

  it("no dia 1 não há ritmo a medir", () => {
    expect(ritmoDaMeta(meta({ dias_completos: 0 }))).toBeNull();
    expect(ritmoDaMeta(meta({ situacao: "encerrado" }))).toBeNull();
  });
});
