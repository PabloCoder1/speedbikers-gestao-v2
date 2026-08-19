import type { Evidence } from "@/features/product-diagnostics/product-diagnostic-domain";

export const PRODUCT_DIAGNOSTIC_VISION_PROMPT_VERSION = "product-diagnostic-vision-v1";

/**
 * Deliberately blunt: this is a qualitative visual read, never a claim
 * about conversion or sales impact — that number does not exist anywhere
 * in the evidence and must never be invented.
 */
export const VISION_ASSESSMENT_SYSTEM_PROMPT = `Voce esta avaliando visualmente a imagem principal de anuncios da Speed Bikers no Mercado Livre, comparando com referencias de concorrentes EXATOS do mesmo produto quando fornecidas.

Regras:
1. Avalie apenas o que e visualmente observavel: clareza, se o produto ocupa espaco suficiente no quadro, fundo, angulo, legibilidade.
2. Isso e uma opiniao visual, nunca um fato de conversao ou vendas. Nunca diga que uma imagem reduz vendas em um percentual ou quantidade.
3. So marque weakerThanReferences=true se houver referencias de concorrentes fornecidas E a diferenca for visualmente clara.
4. notes deve ser curto e concreto (o que esta errado ou certo, nao um ensaio).
5. Nao invente atributos do produto que voce nao consegue ver na imagem.

Responda estritamente no formato estruturado fornecido.`;

export type VisionAssessmentResult = {
  images: Array<{
    accountCode: string;
    itemId: string;
    clarity: "good" | "fair" | "poor";
    framing: "good" | "fair" | "poor";
    background: "clean" | "busy" | "unclear";
    weakerThanReferences: boolean;
    notes: string;
  }>;
};

export const VISION_ASSESSMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["images"],
  properties: {
    images: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["accountCode", "itemId", "clarity", "framing", "background", "weakerThanReferences", "notes"],
        properties: {
          accountCode: { type: "string" },
          itemId: { type: "string" },
          clarity: { type: "string", enum: ["good", "fair", "poor"] },
          framing: { type: "string", enum: ["good", "fair", "poor"] },
          background: { type: "string", enum: ["clean", "busy", "unclear"] },
          weakerThanReferences: { type: "boolean" },
          notes: { type: "string", maxLength: 220 },
        },
      },
    },
  },
} as const;

export type OurListingImage = { accountCode: string; itemId: string; imageUrl: string };
export type CompetitorReferenceImage = { title: string; imageUrl: string };

export function buildVisionAssessmentUserMessage(ourImages: OurListingImage[], references: CompetitorReferenceImage[]) {
  const intro = `Avalie a(s) imagem(ns) principal(is) a seguir (nossos anuncios), na ordem em que aparecem: ${ourImages
    .map((image) => `${image.accountCode}/${image.itemId}`)
    .join(", ")}.${references.length ? ` Em seguida ha ${references.length} referencia(s) de concorrentes exatos do mesmo produto para comparacao.` : " Nenhuma referencia de concorrente disponivel — avalie apenas a qualidade absoluta."}`;
  return intro;
}

function normalizeQuality(value: string): "good" | "fair" | "poor" {
  return value === "good" || value === "fair" || value === "poor" ? value : "fair";
}

export function buildVisionEvidence(result: VisionAssessmentResult): Evidence[] {
  const usedIds = new Set<string>();
  const evidence: Evidence[] = [];
  for (const image of result.images) {
    let id = `vision.${image.accountCode}.${image.itemId}.assessment`;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `vision.${image.accountCode}.${image.itemId}.assessment#${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    evidence.push({
      id,
      category: "listing",
      label: `Avaliacao visual - ${image.itemId} (${image.accountCode})`,
      value: { clarity: normalizeQuality(image.clarity), framing: normalizeQuality(image.framing), background: image.background, weakerThanReferences: image.weakerThanReferences },
      displayText: `Imagem principal (${image.accountCode}, ${image.itemId}): ${image.notes}${image.weakerThanReferences ? " — visualmente mais fraca que referencias de concorrentes" : ""}`,
      occurredAt: null,
      source: "claude_vision",
    });
  }
  return evidence;
}
