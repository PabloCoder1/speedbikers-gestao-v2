import { expect, test } from "@playwright/test";

import { E2E_ML_ACCOUNT, E2E_SHOPEE_SHOP } from "./constants.js";
import { login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

async function reservaDeAdmin(db: ReturnType<typeof clienteDeServico>, organizationId: string): Promise<string> {
  const criado = await db.auth.admin.createUser({
    email: `e2e-reserva-admin-${crypto.randomUUID()}@speedbikers.test`,
    password: `Reserva-${crypto.randomUUID()}`,
    email_confirm: true,
  });
  if (criado.error !== null) throw new Error(criado.error.message);
  const id = criado.data.user.id;
  const membro = await db.from("organization_members").insert({ organization_id: organizationId, user_id: id, role: "ADMIN" });
  if (membro.error !== null) {
    await db.auth.admin.deleteUser(id);
    throw new Error(membro.error.message);
  }
  return id;
}

for (const caso of ["papel", "ML", "Shopee"] as const) {
  for (const acessoRevogado of caso === "papel" ? [true] : [true, false]) {
    test(`Usuários: ${caso} informa ${acessoRevogado ? "autorização perdida" : "acesso já removido"} sem confirmar escrita inexistente`, async ({ page }) => {
      const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
      const db = clienteDeServico();
      const seed = await readSeedOutput();
      const admin = await db.from("organization_members").select("role").eq("organization_id", seed.organizationId).eq("user_id", seed.userId).single();
      const gestor = await db.from("organization_members").select("user_id, role").eq("organization_id", seed.organizationId).eq("role", "GESTOR").single();
      const conta = await db.from("ml_accounts").select("id").eq("organization_id", seed.organizationId).eq("slug", E2E_ML_ACCOUNT.slug).single();
      const loja = await db.from("shopee_shops").select("id").eq("organization_id", seed.organizationId).eq("shop_id", E2E_SHOPEE_SHOP.shopId).single();
      if (admin.error !== null || gestor.error !== null || conta.error !== null || loja.error !== null) throw new Error("Seed de usuários incompleto.");
      const papelAdmin = admin.data.role;
      const contaId = conta.data.id;
      const lojaId = loja.data.id;
      const alvo = gestor.data.user_id;
      const anteriorML = await db.from("user_account_permissions").select("*").eq("user_id", alvo).eq("ml_account_id", conta.data.id).maybeSingle();
      const anteriorShopee = await db.from("user_shopee_shop_permissions").select("*").eq("user_id", alvo).eq("shopee_shop_id", loja.data.id).maybeSingle();
      expect(anteriorML.error).toBeNull();
      expect(anteriorShopee.error).toBeNull();
      let reserva: string | null = null;

      async function restaurarAdmin(): Promise<void> {
        const volta = await db.from("organization_members").update({ role: papelAdmin }).eq("organization_id", seed.organizationId).eq("user_id", seed.userId).select("role").single();
        expect.soft(volta.error).toBeNull();
        expect.soft(volta.data?.role).toBe(papelAdmin);
      }
      async function lerAcesso() {
        return caso === "ML"
          ? db.from("user_account_permissions").select("*").eq("user_id", alvo).eq("ml_account_id", contaId).maybeSingle()
          : db.from("user_shopee_shop_permissions").select("*").eq("user_id", alvo).eq("shopee_shop_id", lojaId).maybeSingle();
      }

      try {
        if (acessoRevogado) reserva = await reservaDeAdmin(db, seed.organizationId);
        if (caso === "ML" && anteriorML.data === null) {
          const concessao = await db.from("user_account_permissions").insert({ user_id: alvo, ml_account_id: contaId });
          expect(concessao.error).toBeNull();
        } else if (caso === "Shopee" && anteriorShopee.data === null) {
          const concessao = await db.from("user_shopee_shop_permissions").insert({ user_id: alvo, shopee_shop_id: lojaId });
          expect(concessao.error).toBeNull();
        }
        const acessoAntes = caso === "papel" ? null : await lerAcesso();
        if (acessoAntes !== null) {
          expect(acessoAntes.error).toBeNull();
          expect(acessoAntes.data).not.toBeNull();
        }

        await login(page, "/usuarios");
        await page.getByRole("region", { name: "Gerenciar acessos" }).getByRole("button", { name: "E2E Gestor", exact: true }).click();
        const gaveta = page.getByRole("dialog", { name: /Detalhe do usuário/u });
        const controle = caso === "papel"
          ? gaveta.getByLabel("Papel do membro")
          : gaveta.getByRole("group", { name: caso === "ML" ? "Contas Mercado Livre permitidas" : "Lojas Shopee permitidas" })
            .getByRole("checkbox", { name: caso === "ML" ? E2E_ML_ACCOUNT.label : E2E_SHOPEE_SHOP.name });
        if (caso !== "papel") await expect(controle).toBeChecked();

        if (acessoRevogado) {
          const revogacao = await db.from("organization_members").update({ role: "OPERADOR" }).eq("organization_id", seed.organizationId).eq("user_id", seed.userId).select("role").single();
          expect(revogacao.error).toBeNull();
          expect(revogacao.data?.role).toBe("OPERADOR");
        } else {
          const removido = caso === "ML"
            ? await db.from("user_account_permissions").delete().eq("user_id", alvo).eq("ml_account_id", conta.data.id)
            : await db.from("user_shopee_shop_permissions").delete().eq("user_id", alvo).eq("shopee_shop_id", loja.data.id);
          expect(removido.error).toBeNull();
        }
        const resposta = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
        if (caso === "papel") await controle.selectOption("ANALISTA");
        else await controle.click();
        expect((await resposta).status()).toBe(200);

        if (caso === "papel") {
          const depois = await db.from("organization_members").select("role").eq("organization_id", seed.organizationId).eq("user_id", alvo).single();
          expect(depois.error).toBeNull();
          expect(depois.data?.role).toBe(gestor.data.role);
        } else {
          const depois = await lerAcesso();
          expect(depois.error).toBeNull();
          expect(depois.data).toEqual(acessoRevogado ? acessoAntes?.data : null);
        }
        const aviso = gaveta.getByRole("alert").filter({ hasText: "Atualize a página para conferir" });
        await expect(aviso).toBeVisible();
        await expect(controle).toBeEnabled();
        if (caso === "papel") await expect(controle).toHaveValue("GESTOR");
        else await expect(controle).toBeChecked();

        if (acessoRevogado) {
          await restaurarAdmin();
          if (caso === "papel") {
            await controle.selectOption("ANALISTA");
            await expect(controle).toHaveValue("ANALISTA");
            const depois = await db.from("organization_members").select("role").eq("organization_id", seed.organizationId).eq("user_id", alvo).single();
            expect(depois.error).toBeNull();
            expect(depois.data?.role).toBe("ANALISTA");
          } else {
            await controle.click();
            await expect(controle).not.toBeChecked();
            const depois = await lerAcesso();
            expect(depois.error).toBeNull();
            expect(depois.data).toBeNull();
          }
        } else {
          await page.reload();
          await page.getByRole("region", { name: "Gerenciar acessos" }).getByRole("button", { name: "E2E Gestor", exact: true }).click();
          await expect(controle).not.toBeChecked();
        }
      } finally {
        await restaurarAdmin();
        const voltaGestor = await db.from("organization_members").update({ role: gestor.data.role }).eq("organization_id", seed.organizationId).eq("user_id", alvo).select("role").single();
        expect.soft(voltaGestor.error).toBeNull();
        expect.soft(voltaGestor.data?.role).toBe(gestor.data.role);
        if (caso === "ML") {
          const volta = anteriorML.data === null
            ? await db.from("user_account_permissions").delete().eq("user_id", alvo).eq("ml_account_id", conta.data.id)
            : await db.from("user_account_permissions").upsert(anteriorML.data, { onConflict: "user_id,ml_account_id" });
          expect.soft(volta.error).toBeNull();
        } else if (caso === "Shopee") {
          const volta = anteriorShopee.data === null
            ? await db.from("user_shopee_shop_permissions").delete().eq("user_id", alvo).eq("shopee_shop_id", loja.data.id)
            : await db.from("user_shopee_shop_permissions").upsert(anteriorShopee.data, { onConflict: "user_id,shopee_shop_id" });
          expect.soft(volta.error).toBeNull();
        }
        if (reserva !== null) {
          const membro = await db.from("organization_members").delete().eq("organization_id", seed.organizationId).eq("user_id", reserva);
          expect.soft(membro.error).toBeNull();
          const usuario = await db.auth.admin.deleteUser(reserva);
          expect.soft(usuario.error).toBeNull();
        }
      }
    });
  }
}
