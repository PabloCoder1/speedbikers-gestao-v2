import { readFileSync } from "node:fs";
const inventario = JSON.parse(readFileSync(new URL("../docs/agent-audit/CLOSURE_INVENTORY.json", import.meta.url), "utf8"));
const estados = new Set(["Não iniciado", "Em andamento", "Implementado", "Testado localmente", "Publicado", "Validado em produção", "Bloqueado"]);
const concluidos = new Set(["Testado localmente", "Publicado", "Validado em produção"]);
const ids = new Set();
for (const item of inventario.entregas) {
  if (ids.has(item.id) || !estados.has(item.status) || ![2, 3, 5, 8].includes(item.peso) || !item.evidencia || !item.responsavel || !item.area || ![1,2,3,4,5].includes(item.fase)) throw new Error("Entrega inválida ou duplicada: " + item.id);
  ids.add(item.id);
}
function calcular(itens) {
  const feitas = itens.filter((item) => concluidos.has(item.status));
  const peso = itens.reduce((soma, item) => soma + item.peso, 0);
  const pesoFechado = feitas.reduce((soma, item) => soma + item.peso, 0);
  if (!peso) throw new Error("Escopo vazio");
  return { entregas: itens.length, fechadas: feitas.length, peso, pesoFechado, percentual: Number((100 * pesoFechado / peso).toFixed(2)), simples: Number((100 * feitas.length / itens.length).toFixed(2)) };
}
console.log(JSON.stringify({ corte: inventario.corte, criterio: inventario.criterio, geral: calcular(inventario.entregas), areas: [...new Set(inventario.entregas.map((item) => item.area))].map((area) => ({ area, ...calcular(inventario.entregas.filter((item) => item.area === area)) })), fases: [1,2,3,4,5].map((fase) => ({ fase, ...calcular(inventario.entregas.filter((item) => item.fase === fase)) })) }, null, 2));
