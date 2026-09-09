import { describe, expect, it } from "vitest";

import { erpImportEtapas } from "./erp-import-steps.js";

/**
 * Etapas do lote de importação (D-278). O caso central é o DENOMINADOR da
 * aplicação: medir contra `total_rows` inventaria uma taxa de falha que não
 * existe, e o lote real de `LINKS` no Dev prova o tamanho do erro.
 */
describe("etapas do lote de importação (D-278)", () => {
  // O lote de LINKS medido no Dev: 23.924 = 20.650 OK + 3.274 ignoradas,
  // aplicadas 20.650.
  const links = {
    status: "APPLIED",
    parsedAt: "2026-08-20T16:09:00Z",
    totalRows: 23924,
    okRows: 20650,
    appliedRows: 20650,
    unresolvedRows: 0,
  };

  it("a aplicação mede sobre as APROVADAS, nunca sobre o total lido", () => {
    const etapas = erpImportEtapas(links);

    expect(etapas[3]?.nota).toBe("20650 de 20650");
    // A guarda contra o defeito: 20.650 de 23.924 seria 86%, e a tela estaria
    // anunciando 14% de falha num lote que aplicou tudo o que devia.
    expect(etapas[3]?.nota).not.toContain("23924");
  });

  it("linha ignorada não é falha — ela aparece na leitura, não na aplicação", () => {
    const etapas = erpImportEtapas(links);

    expect(etapas[1]?.nota).toBe("23924 linhas lidas");
    expect(etapas[2]?.nota).toBe("20650 aprovadas");
    expect(etapas.every((e) => e.estado === "concluida")).toBe(true);
  });

  it("`unresolved` entra como ressalva SÓ quando existe", () => {
    const comPendencia = erpImportEtapas({ ...links, appliedRows: 20600, unresolvedRows: 50 });

    expect(comPendencia[3]?.nota).toBe("20600 de 20650 · 50 pendente(s)");
    // O lote saudável não escreve "0 pendentes": ruído ensina a ignorar aviso.
    expect(erpImportEtapas(links)[3]?.nota).not.toContain("pendente");
  });

  it("PARSED: a conferência é a etapa atual e declara a fração aprovada", () => {
    const etapas = erpImportEtapas({ ...links, status: "PARSED", appliedRows: null, unresolvedRows: null });

    expect(etapas[2]).toEqual({ label: "Conferência", estado: "atual", nota: "20650 de 23924 aprovadas" });
    expect(etapas[3]?.estado).toBe("pendente");
  });

  it("FAILED SEM parsed_at falha na LEITURA; COM ele, na APLICAÇÃO", () => {
    const lendo = erpImportEtapas({ ...links, status: "FAILED", parsedAt: null });
    const aplicando = erpImportEtapas({ ...links, status: "FAILED" });

    expect(lendo[1]?.estado).toBe("falhou");
    expect(lendo[3]?.estado).toBe("pendente");

    expect(aplicando[1]?.estado).toBe("concluida");
    expect(aplicando[3]?.estado).toBe("falhou");
  });

  it("CANCELLED marca onde parou, e nenhuma etapa fica em curso", () => {
    const etapas = erpImportEtapas({
      status: "CANCELLED",
      parsedAt: "2026-08-20T16:09:00Z",
      totalRows: 100,
      okRows: 90,
      appliedRows: null,
      unresolvedRows: null,
    });

    expect(etapas.some((e) => e.estado === "atual")).toBe(false);
    expect(etapas[2]?.estado).toBe("cancelada");
    expect(etapas[3]?.estado).toBe("pendente");
  });

  it("contagens nulas não viram NaN — lote recém-enviado ainda não tem número", () => {
    const etapas = erpImportEtapas({
      status: "UPLOADED",
      parsedAt: null,
      totalRows: null,
      okRows: null,
      appliedRows: null,
      unresolvedRows: null,
    });

    expect(etapas[1]).toEqual({ label: "Leitura da planilha", estado: "atual", nota: "na fila" });
    expect(etapas[2]?.estado).toBe("pendente");
  });
});
