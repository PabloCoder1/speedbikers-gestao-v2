import assert from "node:assert/strict";
import { test } from "node:test";

import { isPublicProxyRoute } from "@/lib/supabase/proxy";

test("o webhook do Mercado Livre responde sem sessao", () => {
  assert.equal(
    isPublicProxyRoute("/api/mercado-livre/notifications"),
    true,
  );
});

test("o worker interno responde sem sessao", () => {
  assert.equal(
    isPublicProxyRoute("/api/internal/ml-sync/worker"),
    true,
  );
});

test("o login responde sem sessao", () => {
  assert.equal(isPublicProxyRoute("/login"), true);
  assert.equal(isPublicProxyRoute("/login/callback"), true);
});

test("as rotas administrativas vizinhas continuam protegidas", () => {
  for (
    const pathname of [
      "/api/mercado-livre/notifications-test",
      "/api/mercado-livre/health",
      "/api/mercado-livre/promotions-debug",
      "/api/mercado-livre/offer-prices-status",
      "/api/mercado-livre/callback",
      "/api/stock/debug",
      "/contas",
      "/",
    ]
  ) {
    assert.equal(
      isPublicProxyRoute(pathname),
      false,
      `${pathname} nao deveria ser publico.`,
    );
  }
});

test("a liberacao e por caminho exato, nao por prefixo", () => {
  assert.equal(
    isPublicProxyRoute("/api/mercado-livre/notifications/extra"),
    false,
  );
  assert.equal(
    isPublicProxyRoute("/api/internal/ml-sync/worker/extra"),
    false,
  );
});
