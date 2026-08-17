"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type ImportIssue = {
  code: string;
  message: string;
  row?: number;
};

type ImportPreview = {
  importId: string;
  status: string;
  duplicateImport: boolean;
  stockRows?: number;
  stockUniqueSkus?: number;
  warehouses?: string[];
  productRows?: number;
  productUniqueSkus?: number;
  relationshipRows?: number;
  relationshipUniqueSkus?: number;
  kitRows?: number;
  kitCount?: number;
  kitMissingStockComponents?: string[];
  blockingIssues?: ImportIssue[];
  warnings?: ImportIssue[];
};

type ImportProgress = {
  status: string;
  phase: string | null;
  cursor_row: number;
  error_message: string | null;
  progress: {
    percent: number;
    phaseProcessedRows: number;
    phaseTotalRows: number;
    elapsedSeconds: number;
    estimatedSecondsRemaining: number | null;
  };
};

type ImportStage =
  | "idle"
  | "previewing"
  | "ready"
  | "queuing"
  | "processing"
  | "complete"
  | "error";

const integer = new Intl.NumberFormat("pt-BR");
const POLL_INTERVAL_MS = 5_000;
const ACTIVE_IMPORT_STORAGE_KEY = "speedbikers:upseller-active-import-id";

const errorMessages: Record<string, string> = {
  required_files_missing: "Selecione as quatro planilhas do UpSeller.",
  upload_too_large: "Os arquivos ultrapassam o limite permitido para a importação.",
  invalid_office_or_zip_signature: "Um dos arquivos não é uma planilha XLSX válida.",
  import_has_blocking_issues: "A pré-validação encontrou problemas que impedem a importação.",
  not_authenticated: "Sua sessão expirou. Entre novamente antes de importar.",
  not_authorized: "Apenas administradores podem importar o estoque.",
};

const phaseLabels: Record<string, string> = {
  stock: "Processando saldos por armazém",
  products: "Processando catálogo e marcas",
  relationships: "Processando vínculos dos anúncios",
  kits: "Processando kits e componentes",
  promote: "Publicando o novo estoque",
  promote_catalog: "Publicando o catálogo",
  promote_stock: "Publicando os saldos físicos",
  promote_relationships: "Publicando as relações de SKU",
  promote_kits: "Publicando os kits exportados",
  derive_kits: "Validando kits por ponto",
  build_links_exact: "Vinculando SKUs exatos",
  build_links_item: "Vinculando anúncios",
  build_links_variation: "Vinculando variações",
  build_links_user_product: "Vinculando produtos do canal",
  promote_links: "Consolidando vínculos de estoque",
  finalize: "Finalizando e reavaliando alertas",
};

function selectedFile(data: FormData, name: string) {
  const value = data.get(name);
  return value instanceof File && value.size > 0 ? value : null;
}

function responseError(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    const code = String(payload.error);
    return errorMessages[code] ?? fallback;
  }
  return fallback;
}

function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function formatRemainingTime(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return "Calculando tempo restante...";
  if (seconds < 60) return "Menos de 1 minuto restante";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `Cerca de ${integer.format(minutes)} min restantes`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `Cerca de ${integer.format(hours)}h ${integer.format(remainingMinutes)}min restantes`
    : `Cerca de ${integer.format(hours)}h restantes`;
}

function FileField({
  id,
  name,
  label,
  helper,
  disabled,
}: {
  id: string;
  name: string;
  label: string;
  helper: string;
  disabled: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-gray-900">
        {label}
      </label>
      <p className="mt-1 text-xs leading-5 text-gray-500">{helper}</p>
      <input
        id={id}
        name={name}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        required
        disabled={disabled}
        className="mt-3 block w-full cursor-pointer rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-600 file:mr-4 file:border-0 file:border-r file:border-gray-200 file:bg-white file:px-4 file:py-3 file:text-sm file:font-semibold file:text-gray-950 hover:file:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </div>
  );
}

export function UpsellerImportForm() {
  const router = useRouter();
  const monitorAbortRef = useRef<AbortController | null>(null);
  const [stage, setStage] = useState<ImportStage>("idle");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = ["previewing", "queuing", "processing"].includes(stage);

  const monitorImport = useCallback(async (importId: string) => {
    monitorAbortRef.current?.abort();
    const controller = new AbortController();
    monitorAbortRef.current = controller;
    setStage("processing");

    try {
      while (!controller.signal.aborted) {
        const response = await fetch(`/api/upseller/imports/${importId}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as ImportProgress & { error?: string };

        if (!response.ok) {
          throw new Error(responseError(payload, "Não foi possível acompanhar a importação."));
        }

        setProgress(payload);

        if (payload.status === "applied") {
          setStage("complete");
          router.refresh();
          return;
        }

        if (payload.status === "failed") {
          throw new Error(payload.error_message ?? "A importação falhou durante o processamento.");
        }

        await pause(POLL_INTERVAL_MS, controller.signal);
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      throw caught;
    } finally {
      if (monitorAbortRef.current === controller) monitorAbortRef.current = null;
    }
  }, [router]);

  useEffect(() => {
    const activeImportId = window.localStorage.getItem(ACTIVE_IMPORT_STORAGE_KEY);
    const resumeTimeout = activeImportId ? window.setTimeout(() => {
      void monitorImport(activeImportId).catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Não foi possível acompanhar a importação.");
        setStage("error");
      });
    }, 0) : null;
    return () => {
      if (resumeTimeout !== null) window.clearTimeout(resumeTimeout);
      monitorAbortRef.current?.abort();
    };
  }, [monitorImport]);

  async function handlePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    monitorAbortRef.current?.abort();
    window.localStorage.removeItem(ACTIVE_IMPORT_STORAGE_KEY);
    setError(null);
    setPreview(null);
    setProgress(null);

    try {
      const formData = new FormData(event.currentTarget);
      const stock = selectedFile(formData, "stock");
      const relationships = selectedFile(formData, "relationships");
      const products = selectedFile(formData, "products");
      const kits = selectedFile(formData, "kits");

      if (!stock || !relationships || !products || !kits) {
        throw new Error(errorMessages.required_files_missing);
      }

      const upload = new FormData();
      upload.append("stock", stock, stock.name);
      upload.append("relationships", relationships, relationships.name);
      upload.append("products", products, products.name);
      upload.append("kits", kits, kits.name);

      setStage("previewing");
      const response = await fetch("/api/upseller/imports/preview", {
        method: "POST",
        body: upload,
      });
      const payload = await response.json() as ImportPreview & { error?: string };

      if (!response.ok) {
        throw new Error(responseError(payload, "Não foi possível validar as planilhas."));
      }

      setPreview(payload);

      if (payload.status === "applied") {
        window.localStorage.setItem(ACTIVE_IMPORT_STORAGE_KEY, payload.importId);
        setStage("complete");
        return;
      }

      if (payload.status === "queued" || payload.status === "running" || payload.status === "processing") {
        window.localStorage.setItem(ACTIVE_IMPORT_STORAGE_KEY, payload.importId);
        await monitorImport(payload.importId);
        return;
      }

      setStage("ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível preparar a importação.");
      setStage("error");
    }
  }

  async function handleCommit() {
    if (!preview || (preview.blockingIssues?.length ?? 0) > 0) return;

    setError(null);
    setStage("queuing");

    try {
      const response = await fetch(`/api/upseller/imports/${preview.importId}/commit`, {
        method: "POST",
      });
      const payload = await response.json() as { error?: string };

      if (!response.ok) {
        throw new Error(responseError(payload, "Não foi possível iniciar a importação."));
      }

      window.localStorage.setItem(ACTIVE_IMPORT_STORAGE_KEY, preview.importId);
      await monitorImport(preview.importId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível concluir a importação.");
      setStage("error");
    }
  }

  const blockingIssues = preview?.blockingIssues ?? [];
  const warnings = preview?.warnings ?? [];

  return (
    <div>
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        <strong>Regra confirmada:</strong> a coluna “Categorias” será gravada como marca, inclusive para valores numéricos ou rótulos como “ESTOQUE INATIVO”.
      </div>

      <form onSubmit={handlePreview} className="mt-6">
        <div className="grid gap-5 md:grid-cols-2">
          <FileField
            id="upseller-stock"
            name="stock"
            label="1. Lista de estoque"
            helper="Arquivo Lista_de_Estoque...xlsx com saldos e armazéns."
            disabled={busy}
          />
          <FileField
            id="upseller-products"
            name="products"
            label="2. Produtos do armazém"
            helper="Arquivo export_warehouse_products...xlsx com catálogo e categorias."
            disabled={busy}
          />
          <FileField
            id="upseller-kits"
            name="kits"
            label="3. Kits"
            helper="Arquivo export_kit...xlsx com componentes e quantidades."
            disabled={busy}
          />
          <FileField
            id="upseller-relationships"
            name="relationships"
            label="4. Relações de SKU"
            helper="Arquivo SKU_Map_Relationship...xlsx com os vínculos dos canais."
            disabled={busy}
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            {stage === "previewing" ? "Validando planilhas..." : "Validar planilhas"}
          </Button>
          <p className="text-xs leading-5 text-gray-500">
            A validação não altera o estoque. Você confirma a importação no passo seguinte.
          </p>
        </div>
      </form>

      {error ? (
        <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {preview ? (
        <section className="mt-6 rounded-2xl border border-gray-200 bg-gray-50 p-5" aria-labelledby="upseller-preview-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="upseller-preview-title" className="text-sm font-semibold text-gray-950">
                Resultado da pré-validação
              </h3>
              <p className="mt-1 text-xs text-gray-500">
                {preview.duplicateImport ? "Este mesmo pacote já havia sido enviado." : "Pacote novo e pronto para conferência."}
              </p>
            </div>
            <Badge variant={blockingIssues.length > 0 ? "danger" : "success"}>
              {blockingIssues.length > 0 ? "Correção necessária" : "Sem bloqueios"}
            </Badge>
          </div>

          <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-white p-4 ring-1 ring-inset ring-gray-200">
              <dt className="text-xs text-gray-500">Saldos</dt>
              <dd className="mt-2 text-xl font-bold text-gray-950">{integer.format(preview.stockRows ?? 0)}</dd>
            </div>
            <div className="rounded-xl bg-white p-4 ring-1 ring-inset ring-gray-200">
              <dt className="text-xs text-gray-500">Produtos</dt>
              <dd className="mt-2 text-xl font-bold text-gray-950">{integer.format(preview.productRows ?? 0)}</dd>
            </div>
            <div className="rounded-xl bg-white p-4 ring-1 ring-inset ring-gray-200">
              <dt className="text-xs text-gray-500">Relações</dt>
              <dd className="mt-2 text-xl font-bold text-gray-950">{integer.format(preview.relationshipRows ?? 0)}</dd>
            </div>
            <div className="rounded-xl bg-white p-4 ring-1 ring-inset ring-gray-200">
              <dt className="text-xs text-gray-500">Kits</dt>
              <dd className="mt-2 text-xl font-bold text-gray-950">{integer.format(preview.kitCount ?? 0)}</dd>
            </div>
          </dl>

          {blockingIssues.length > 0 ? (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-semibold text-red-900">Problemas que impedem a carga</p>
              <ul className="mt-2 space-y-1 text-xs leading-5 text-red-700">
                {blockingIssues.slice(0, 8).map((issue, index) => (
                  <li key={`${issue.code}-${issue.row ?? index}`}>
                    {issue.message}{issue.row ? ` · linha ${integer.format(issue.row)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {warnings.length > 0 ? (
            <details className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <summary className="cursor-pointer text-sm font-semibold text-amber-900">
                {integer.format(warnings.length)} aviso(s) não bloqueante(s)
              </summary>
              <ul className="mt-3 space-y-1 text-xs leading-5 text-amber-800">
                {warnings.slice(0, 8).map((issue, index) => (
                  <li key={`${issue.code}-${issue.row ?? index}`}>
                    {issue.message}{issue.row ? ` · linha ${integer.format(issue.row)}` : ""}
                  </li>
                ))}
                {warnings.length > 8 ? <li>Mais {integer.format(warnings.length - 8)} aviso(s).</li> : null}
              </ul>
            </details>
          ) : null}

          {stage === "ready" && blockingIssues.length === 0 ? (
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-5">
              <Button type="button" onClick={handleCommit}>
                Importar estoque agora
              </Button>
              <p className="text-xs text-gray-500">
                A publicação ocorre em etapas e pode levar alguns minutos.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {stage === "processing" ? (
        <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-start gap-3">
            <span className="mt-1 h-3 w-3 shrink-0 animate-pulse rounded-full bg-blue-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-semibold text-blue-950">
                  {progress?.phase ? phaseLabels[progress.phase] ?? "Processando importação" : "Importação na fila"}
                </p>
                <span className="text-sm font-bold tabular-nums text-blue-950">
                  {progress ? `${progress.progress.percent.toFixed(1).replace(".", ",")}%` : "0,0%"}
                </span>
              </div>
              <div
                className="mt-3 h-3 overflow-hidden rounded-full bg-blue-100 ring-1 ring-inset ring-blue-200"
                role="progressbar"
                aria-label="Progresso da importação do UpSeller"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress?.progress.percent ?? 0}
              >
                <div
                  className="h-full rounded-full bg-blue-600 transition-[width] duration-500 ease-out"
                  style={{ width: `${progress?.progress.percent ?? 0}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs leading-5 text-blue-800">
                <span>
                  {progress?.progress.phaseTotalRows
                    ? `${integer.format(progress.progress.phaseProcessedRows)} de ${integer.format(progress.progress.phaseTotalRows)} nesta etapa`
                    : "Preparando a primeira etapa"}
                </span>
                <span>{formatRemainingTime(progress?.progress.estimatedSecondsRemaining)}</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-blue-800">
                O tempo é aproximado e o processamento continua mesmo se você sair desta página.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {stage === "complete" ? (
        <div className="mt-5 rounded-xl border border-green-200 bg-green-50 p-5">
          <Badge variant="success">Importação concluída</Badge>
          <p className="mt-3 text-sm font-semibold text-green-950">
            O estoque físico, os custos, as marcas e os kits já foram publicados.
          </p>
          <p className="mt-1 text-xs leading-5 text-green-800">
            Os avisos de “aguardando upload” desaparecem automaticamente após a atualização da tela de estoque.
          </p>
          <Link href="/estoque" className="mt-4 inline-flex text-sm font-semibold text-green-900 underline underline-offset-4">
            Abrir a visão de estoque →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
