import nodemailer from "nodemailer";

/**
 * O e-mail do alerta de venda abaixo da margem (D-858).
 *
 * Duas peças separadas de propósito: `composeMarginAlertEmail` é pura (o texto
 * sai só dos números que o banco gravou, e o teste a confere sem rede), e o
 * `EmailSender` é a porta para o SMTP. O worker funciona sem SMTP configurado:
 * o alerta continua caindo no sino, e o e-mail espera a configuração.
 */

export interface MarginAlertRow {
  id: string;
  marketplace: "MERCADO_LIVRE" | "SHOPEE";
  order_ref: string;
  sku_id: string | null;
  sku: string | null;
  title: string | null;
  brand: string | null;
  imported: boolean;
  quantity: number | null;
  sold_at: string;
  sale_value: number;
  net_received: number;
  product_cost: number;
  margin: number;
  min_margin: number;
  cost_is_current: boolean;
  /** O rótulo da conta do ML ou o nome da loja da Shopee. */
  conta: string | null;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const PCT = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const META = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 });

function canal(marketplace: MarginAlertRow["marketplace"]): string {
  return marketplace === "SHOPEE" ? "Shopee" : "Mercado Livre";
}

function quando(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function produto(a: MarginAlertRow): string {
  const nome = a.title ?? "Produto sem título";

  return a.sku === null ? nome : `${a.sku} · ${nome}`;
}

function linhaDeTexto(a: MarginAlertRow): string {
  const meta = a.imported ? `${META.format(a.min_margin)}, marca importada` : META.format(a.min_margin);
  const custo = a.cost_is_current ? " (custo do cadastro atual)" : "";

  return [
    `- ${produto(a)}`,
    `  ${canal(a.marketplace)}${a.conta === null ? "" : ` · ${a.conta}`} · pedido ${a.order_ref} · ${quando(a.sold_at)}`,
    `  Margem ${PCT.format(a.margin)} (meta ${meta})`,
    `  Venda ${BRL.format(a.sale_value)} · recebido ${BRL.format(a.net_received)} · custo ${BRL.format(a.product_cost)}${custo}`,
  ].join("\n");
}

/**
 * Um e-mail por rodada com TODAS as vendas novas: cada venda fora da margem
 * aparece, e a caixa de quem recebe não leva vinte mensagens numa hora.
 */
export function composeMarginAlertEmail(
  alerts: readonly MarginAlertRow[],
  options: { to: string[]; appUrl?: string | undefined },
): EmailMessage {
  const primeira = alerts[0];

  if (primeira === undefined) throw new Error("composeMarginAlertEmail sem alerta");

  const subject =
    alerts.length === 1
      ? `Venda abaixo da margem: ${primeira.sku ?? primeira.title ?? "produto"} com ${PCT.format(primeira.margin)} (meta ${META.format(primeira.min_margin)})`
      : `${String(alerts.length)} vendas abaixo da margem`;

  const base = options.appUrl?.replace(/\/+$/, "");
  const rodape =
    "Margem = (valor líquido recebido − custo do produto) ÷ valor de venda, a mesma da Curva ABC. " +
    "No Mercado Livre, o recebido é o preço menos a comissão e o frete pago pelo vendedor; na Shopee, o repasse da Shopee. " +
    "Imposto, Ads e custos fixos ficam fora.";

  const text = [
    alerts.length === 1 ? "Uma venda saiu abaixo da margem mínima:" : `${String(alerts.length)} vendas saíram abaixo da margem mínima:`,
    "",
    alerts.map(linhaDeTexto).join("\n\n"),
    "",
    rodape,
    base === undefined ? "" : `\nVer no sistema: ${base}/notificacoes`,
  ].join("\n");

  const linhas = alerts
    .map((a) => {
      const link = base !== undefined && a.sku_id !== null ? `${base}/skus/${encodeURIComponent(a.sku_id)}` : null;
      const nome = escapeHtml(produto(a));
      const meta = a.imported ? `${META.format(a.min_margin)} (importada)` : META.format(a.min_margin);

      return `<tr>
  <td style="padding:8px;border-bottom:1px solid #ddd">${link === null ? nome : `<a href="${escapeHtml(link)}">${nome}</a>`}<br><small>${escapeHtml(canal(a.marketplace))}${a.conta === null ? "" : ` · ${escapeHtml(a.conta)}`} · pedido ${escapeHtml(a.order_ref)} · ${escapeHtml(quando(a.sold_at))}</small></td>
  <td style="padding:8px;border-bottom:1px solid #ddd;text-align:right;color:#b42318"><strong>${PCT.format(a.margin)}</strong><br><small>meta ${meta}</small></td>
  <td style="padding:8px;border-bottom:1px solid #ddd;text-align:right">${BRL.format(a.sale_value)}<br><small>recebido ${BRL.format(a.net_received)}<br>custo ${BRL.format(a.product_cost)}${a.cost_is_current ? " (cadastro atual)" : ""}</small></td>
</tr>`;
    })
    .join("\n");

  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<p>${alerts.length === 1 ? "Uma venda saiu abaixo da margem mínima:" : `${String(alerts.length)} vendas saíram abaixo da margem mínima:`}</p>
<table style="border-collapse:collapse;width:100%;max-width:720px">
<thead><tr><th style="text-align:left;padding:8px;border-bottom:2px solid #111">Produto</th><th style="text-align:right;padding:8px;border-bottom:2px solid #111">Margem</th><th style="text-align:right;padding:8px;border-bottom:2px solid #111">Valores</th></tr></thead>
<tbody>
${linhas}
</tbody>
</table>
<p style="color:#555;font-size:12px">${escapeHtml(rodape)}</p>
${base === undefined ? "" : `<p><a href="${escapeHtml(`${base}/notificacoes`)}">Ver no sistema</a></p>`}
</div>`;

  return { to: options.to, subject, text, html };
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

/** SMTP genérico: Gmail com senha de app, Brevo, Resend, SES... A porta 465 usa TLS direto; as outras, STARTTLS. */
export function createSmtpSender(config: SmtpConfig): EmailSender {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
  });

  return {
    async send(message) {
      await transport.sendMail({
        from: config.from,
        // Os destinatários não veem uns aos outros.
        to: config.from,
        bcc: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}
