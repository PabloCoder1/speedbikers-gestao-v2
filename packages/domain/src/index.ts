/**
 * Lógica de negócio PURA: sem banco, sem rede, sem framework.
 *
 * `docs/ARCHITECTURE.md` secao 7 — é a peça central do repositório. Toda regra
 * determinística mora aqui, roda em milissegundos e é testável exaustivamente.
 *
 * Regra da fórmula única: se uma fórmula também existir em SQL por
 * performance, a versão SQL é derivada E existe teste de equivalência na CI.
 */

export * from "./upseller/index.js";
export * from "./events/index.js";
export * from "./metrics/index.js";
export * from "./inventory/index.js";
export * from "./nfe/index.js";
export * from "./purchasing/index.js";
