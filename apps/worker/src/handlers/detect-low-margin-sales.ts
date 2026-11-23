import type { AdminClient } from "@sb/db";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { EmailSender, MarginAlertRow } from "../margin-alert-email.js";
import { composeMarginAlertEmail } from "../margin-alert-email.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * `diagnostics.detect-low-margin-sales` (D-858) — a venda abaixo da margem
 * avisa no sino e por e-mail.
 *
 * **O julgamento mora no banco.** `detectar_vendas_abaixo_da_margem` calcula a
 * margem de cada pedido coberto dos últimos 7 dias pela regra de 5X, compara
 * com a meta da marca e grava, numa transação, o alerta e o `domain_event`
 * que o fan-out transforma em notificação. Este handler chama e depois manda
 * o e-mail dos alertas que ainda não saíram.
 *
 * **O e-mail não desfaz nada.** Falhou o SMTP: o alerta continua no sino, o
 * e-mail fica pendente e a rodada seguinte (de hora em hora, junto do piso de
 * métricas) tenta de novo. Depois de 5 tentativas o alerta vira `failed`, e o
 * que ficou pendente mais de 48 h (SMTP sem configurar) vira `skipped`: ninguém
 * recebe na quinta-feira o aviso de uma venda da segunda.
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

const resumoSchema = z.object({
  ativo: z.boolean(),
  novos: z.number(),
  notificadas: z.number(),
  julgados: z.object({ mercado_livre: z.number(), shopee: z.number() }).optional(),
});

export const MAX_EMAIL_ATTEMPTS = 5;
export const PENDING_EMAIL_TTL_HOURS = 48;
const LOTE = 50;

export interface PendingAlert extends MarginAlertRow {
  email_attempts: number;
}

/** O acesso ao banco, numa porta para o teste trocar. */
export interface MarginAlertStore {
  detect(organizationId: string): Promise<{ data: unknown; error: string | null }>;
  expirePending(organizationId: string, before: Date): Promise<string | null>;
  listPending(organizationId: string, limit: number): Promise<{ data: PendingAlert[]; error: string | null }>;
  recipients(organizationId: string): Promise<{ data: string[]; error: string | null }>;
  markSent(ids: string[], at: Date): Promise<string | null>;
  markSkipped(ids: string[], reason: string): Promise<string | null>;
  markAttemptFailed(alert: PendingAlert, reason: string, final: boolean): Promise<string | null>;
}

export interface DetectLowMarginSalesDeps {
  store: MarginAlertStore;
  /** `null` = SMTP sem configurar: o sino funciona, o e-mail espera. */
  email: EmailSender | null;
  appUrl?: string | undefined;
  now?: () => Date;
}

export function createDetectLowMarginSalesHandler(deps: DetectLowMarginSalesDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem organizationId" };
    }

    const { organizationId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const detectado = await deps.store.detect(organizationId);

    if (detectado.error !== null) {
      return { status: "failed", retryable: true, reason: `detectar_vendas_abaixo_da_margem: ${detectado.error}` };
    }

    const resumo = resumoSchema.safeParse(detectado.data);

    if (!resumo.success) {
      return { status: "failed", retryable: false, reason: "detectar_vendas_abaixo_da_margem fora do contrato" };
    }

    context.logger.info("low_margin_sales_detected", {
      organization_id: organizationId,
      ativo: resumo.data.ativo,
      novos: resumo.data.novos,
      notificadas: resumo.data.notificadas,
      julgados_ml: resumo.data.julgados?.mercado_livre ?? null,
      julgados_shopee: resumo.data.julgados?.shopee ?? null,
    });

    const expirou = await deps.store.expirePending(
      organizationId,
      new Date(now.getTime() - PENDING_EMAIL_TTL_HOURS * 3_600_000),
    );

    if (expirou !== null) {
      return { status: "failed", retryable: true, reason: `expirar e-mails pendentes: ${expirou}` };
    }

    const pendentes = await deps.store.listPending(organizationId, LOTE);

    if (pendentes.error !== null) {
      return { status: "failed", retryable: true, reason: `ler e-mails pendentes: ${pendentes.error}` };
    }

    if (pendentes.data.length === 0) {
      return { status: "done", processed: resumo.data.novos };
    }

    const ids = pendentes.data.map((a) => a.id);
    const destinatarios = await deps.store.recipients(organizationId);

    if (destinatarios.error !== null) {
      return { status: "failed", retryable: true, reason: `ler destinatários: ${destinatarios.error}` };
    }

    if (destinatarios.data.length === 0) {
      const erro = await deps.store.markSkipped(ids, "sem destinatário cadastrado");

      context.logger.info("low_margin_email_skipped", { organization_id: organizationId, alertas: ids.length, motivo: "sem_destinatario" });

      return erro === null
        ? { status: "done", processed: resumo.data.novos }
        : { status: "failed", retryable: true, reason: `marcar sem destinatário: ${erro}` };
    }

    if (deps.email === null) {
      // Fica pendente: quando o SMTP for configurado, sai o que tiver menos de 48 h.
      context.logger.warn("low_margin_email_not_configured", { organization_id: organizationId, pendentes: ids.length });

      return { status: "done", processed: resumo.data.novos };
    }

    const mensagem = composeMarginAlertEmail(pendentes.data, { to: destinatarios.data, appUrl: deps.appUrl });

    try {
      await deps.email.send(mensagem);
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);

      for (const alerta of pendentes.data) {
        await deps.store.markAttemptFailed(alerta, motivo.slice(0, 500), alerta.email_attempts + 1 >= MAX_EMAIL_ATTEMPTS);
      }

      context.logger.warn("low_margin_email_failed", { organization_id: organizationId, alertas: ids.length, motivo });

      return { status: "failed", retryable: true, reason: `envio do e-mail: ${motivo}` };
    }

    const marcado = await deps.store.markSent(ids, now);

    context.logger.info("low_margin_email_sent", {
      organization_id: organizationId,
      alertas: ids.length,
      destinatarios: destinatarios.data.length,
    });

    // O e-mail já saiu: falhar aqui faria o Cloud Tasks reenviar a mesma mensagem.
    if (marcado !== null) {
      context.logger.error("low_margin_email_mark_failed", { organization_id: organizationId, motivo: marcado });
    }

    return { status: "done", processed: resumo.data.novos };
  };
}

const pendingRowSchema = z.object({
  id: z.string(),
  marketplace: z.enum(["MERCADO_LIVRE", "SHOPEE"]),
  order_ref: z.string(),
  sku_id: z.string().nullable(),
  sku: z.string().nullable(),
  title: z.string().nullable(),
  brand: z.string().nullable(),
  imported: z.boolean(),
  quantity: z.number().nullable(),
  sold_at: z.string(),
  sale_value: z.coerce.number(),
  net_received: z.coerce.number(),
  product_cost: z.coerce.number(),
  margin: z.coerce.number(),
  min_margin: z.coerce.number(),
  cost_is_current: z.boolean(),
  email_attempts: z.number(),
  ml_accounts: z.object({ label: z.string() }).nullable(),
  shopee_shops: z.object({ shop_name: z.string().nullable(), shop_id: z.coerce.string() }).nullable(),
});

/** O `MarginAlertStore` de verdade, sobre o cliente service_role. */
export function createSupabaseMarginAlertStore(db: AdminClient): MarginAlertStore {
  return {
    async detect(organizationId) {
      const r = await db.rpc("detectar_vendas_abaixo_da_margem", { p_organization_id: organizationId });

      return { data: r.data, error: r.error?.message ?? null };
    },
    async expirePending(organizationId, before) {
      const r = await db
        .from("sale_margin_alerts")
        .update({ email_status: "skipped", email_error: `pendente há mais de ${String(PENDING_EMAIL_TTL_HOURS)} h` })
        .eq("organization_id", organizationId)
        .eq("email_status", "pending")
        .lt("detected_at", before.toISOString());

      return r.error?.message ?? null;
    },
    async listPending(organizationId, limit) {
      const r = await db
        .from("sale_margin_alerts")
        .select(
          "id, marketplace, order_ref, sku_id, sku, title, brand, imported, quantity, sold_at, sale_value, net_received, product_cost, margin, min_margin, cost_is_current, email_attempts, ml_accounts(label), shopee_shops(shop_name, shop_id)",
        )
        .eq("organization_id", organizationId)
        .eq("email_status", "pending")
        .order("sold_at", { ascending: true })
        .limit(limit);

      if (r.error !== null) return { data: [], error: r.error.message };

      const linhas = z.array(pendingRowSchema).safeParse(r.data);

      if (!linhas.success) return { data: [], error: "sale_margin_alerts fora do contrato" };

      return {
        data: linhas.data.map(({ ml_accounts, shopee_shops, ...a }) => ({
          ...a,
          conta: ml_accounts?.label ?? shopee_shops?.shop_name ?? shopee_shops?.shop_id ?? null,
        })),
        error: null,
      };
    },
    async recipients(organizationId) {
      const r = await db
        .from("margin_alert_settings")
        .select("email_recipients, enabled")
        .eq("organization_id", organizationId)
        .maybeSingle();

      if (r.error !== null) return { data: [], error: r.error.message };

      return { data: r.data?.enabled === true ? r.data.email_recipients : [], error: null };
    },
    async markSent(ids, at) {
      const r = await db
        .from("sale_margin_alerts")
        .update({ email_status: "sent", email_sent_at: at.toISOString(), email_error: null })
        .in("id", ids);

      return r.error?.message ?? null;
    },
    async markSkipped(ids, reason) {
      const r = await db.from("sale_margin_alerts").update({ email_status: "skipped", email_error: reason }).in("id", ids);

      return r.error?.message ?? null;
    },
    async markAttemptFailed(alert, reason, final) {
      const r = await db
        .from("sale_margin_alerts")
        .update({ email_status: final ? "failed" : "pending", email_attempts: alert.email_attempts + 1, email_error: reason })
        .eq("id", alert.id);

      return r.error?.message ?? null;
    },
  };
}
