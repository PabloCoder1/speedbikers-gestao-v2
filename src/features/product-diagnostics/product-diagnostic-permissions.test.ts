import assert from "node:assert/strict";
import { test } from "node:test";

import { canForceProductDiagnostic, canGenerateProductDiagnostics } from "./product-diagnostic-permissions";

// 19. visualizador (e operador) não podem acionar o custo de IA
test("visualizador and operador cannot trigger a Claude analysis", () => {
  assert.equal(canGenerateProductDiagnostics("visualizador", false), false);
  assert.equal(canGenerateProductDiagnostics("operador", false), false);
});

test("admin, gestor and analista can trigger a Claude analysis", () => {
  assert.equal(canGenerateProductDiagnostics("admin", false), true);
  assert.equal(canGenerateProductDiagnostics("gestor", false), true);
  assert.equal(canGenerateProductDiagnostics("analista", false), true);
});

test("a pending must-change-password gate blocks generation even for an admin", () => {
  assert.equal(canGenerateProductDiagnostics("admin", true), false);
});

test("force bypass is restricted to the same generate-tier roles", () => {
  assert.equal(canForceProductDiagnostic("visualizador", false), false);
  assert.equal(canForceProductDiagnostic("gestor", false), true);
});
