import { Badge } from "@/components/ui/badge";
import type { getProductStockIntelligence } from "@/features/stock/get-product-stock-intelligence";

type ProductStockIntelligence = NonNullable<
  Awaited<ReturnType<typeof getProductStockIntelligence>>
>;

type ProductStockIntelligencePanelProps = {
  data: ProductStockIntelligence | null;
};

type WarehouseView = {
  key: string;
  name: string;
  shelf: string | null;
  available: number | null;
  current: number | null;
  occupied: number | null;
  purchaseInTransit: number | null;
  transferInTransit: number | null;
  lowStockThreshold: number | null;
};

type KitComponentView = {
  sku: string;
  requiredQuantity: number | null;
  effectiveCost: number | null;
};

const integer = new Intl.NumberFormat("pt-BR");

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

function numberOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function formatQuantity(value: number | null) {
  return value === null ? "—" : integer.format(value);
}

function formatCurrency(value: number | null) {
  return value === null ? "—" : currency.format(value);
}

function formatCheckedAt(value: unknown) {
  const raw = stringOrNull(value);
  if (!raw) return "Ainda não atualizado";
  const date = new Date(raw);
  return Number.isNaN(date.getTime())
    ? "Data de atualização indisponível"
    : `Atualizado em ${dateTime.format(date)}`;
}

function readWarehouses(value: unknown): WarehouseView[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const key = stringOrNull(row.key);
    const name = stringOrNull(row.name);
    if (!key && !name) return [];

    return [{
      key: key ?? name ?? "deposito",
      name: name ?? key ?? "Depósito",
      shelf: stringOrNull(row.shelf),
      available: numberOrNull(row.available),
      current: numberOrNull(row.current),
      occupied: numberOrNull(row.occupied),
      purchaseInTransit: numberOrNull(row.purchaseInTransit),
      transferInTransit: numberOrNull(row.transferInTransit),
      lowStockThreshold: numberOrNull(row.lowStockThreshold),
    }];
  });
}

function readKitComponents(value: unknown): KitComponentView[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const sku = stringOrNull(row.sku);
    if (!sku) return [];

    return [{
      sku,
      requiredQuantity: numberOrNull(row.requiredQuantity),
      effectiveCost: numberOrNull(row.effectiveCost),
    }];
  });
}

function MetricCard({
  eyebrow,
  label,
  value,
  helper,
  tone,
}: {
  eyebrow: string;
  label: string;
  value: string;
  helper: string;
  tone: "slate" | "emerald" | "blue" | "amber";
}) {
  const toneClasses = {
    slate: "bg-gray-950 text-white",
    emerald: "bg-emerald-950 text-white",
    blue: "bg-blue-950 text-white",
    amber: "bg-amber-50 text-gray-950 ring-1 ring-inset ring-amber-200",
  }[tone];

  const mutedClasses = tone === "amber"
    ? "text-amber-800/70"
    : "text-white/60";

  return (
    <div className={`rounded-2xl p-5 shadow-sm ${toneClasses}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-[0.16em] ${mutedClasses}`}>
        {eyebrow}
      </p>
      <p className="mt-4 text-3xl font-bold tracking-tight">
        {value}
      </p>
      <p className="mt-1 text-sm font-semibold">
        {label}
      </p>
      <p className={`mt-3 text-xs leading-5 ${mutedClasses}`}>
        {helper}
      </p>
    </div>
  );
}

function AvailabilityRow({
  label,
  description,
  value,
  state,
}: {
  label: string;
  description: string;
  value: string;
  state: "ready" | "pending" | "inactive";
}) {
  const dotClass = {
    ready: "bg-emerald-500",
    pending: "bg-amber-500",
    inactive: "bg-gray-300",
  }[state];

  return (
    <div className="flex items-center justify-between gap-4 border-b border-gray-100 py-4 last:border-b-0">
      <div className="flex min-w-0 items-start gap-3">
        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`} />
        <div>
          <p className="text-sm font-semibold text-gray-950">
            {label}
          </p>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            {description}
          </p>
        </div>
      </div>
      <p className="shrink-0 text-right text-lg font-bold tracking-tight text-gray-950">
        {value}
      </p>
    </div>
  );
}

function UnavailablePanel() {
  return (
    <section className="mt-8" aria-labelledby="stock-intelligence-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="stock-intelligence-title" className="text-sm font-semibold text-gray-950">
            Estoque e disponibilidade
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Estoque físico, Full separado por conta e saldo publicado
          </p>
        </div>
        <Badge variant="warning">Temporariamente indisponível</Badge>
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 shadow-sm">
        <p className="text-sm font-semibold text-amber-950">
          Não foi possível carregar a inteligência de estoque agora.
        </p>
        <p className="mt-2 max-w-3xl text-xs leading-5 text-amber-800">
          As informações comerciais do produto continuam disponíveis. Tente novamente depois que a sincronização terminar.
        </p>
      </div>
    </section>
  );
}

export function ProductStockIntelligencePanel({
  data,
}: ProductStockIntelligencePanelProps) {
  if (!data) return <UnavailablePanel />;

  const physical = data.physical;
  const physicalReady = physical.ready === true;
  const physicalAvailable = numberOrNull(physical.available);
  const physicalCurrent = numberOrNull(physical.current);
  const physicalOccupied = numberOrNull(physical.occupied);
  const lowStockThreshold = numberOrNull(physical.lowStockThreshold);
  const effectiveCost = numberOrNull(physical.effectiveCost);
  const isKit = physical.kind === "kit";
  const warehouses = readWarehouses(physical.warehouses);
  const kitComponents = readKitComponents(physical.limitingComponents);
  const advertisedHasOffers = data.advertised.listingCount > 0;

  const readiness = data.mapping.status === "conflict"
    ? { label: "Revisão necessária", variant: "danger" as const }
    : data.mapping.status === "missing"
      ? { label: "Aguardando UpSeller", variant: "warning" as const }
      : physicalReady && (!data.full.applicable || data.full.ready)
        ? { label: "Dados conectados", variant: "success" as const }
        : { label: "Dados parciais", variant: "info" as const };

  const physicalHelper = data.mapping.status === "missing"
    ? "Será preenchido após a primeira importação do UpSeller"
    : physicalReady
      ? `${isKit ? "Capacidade calculada do kit" : "Disponível no estoque físico"} · ${formatCheckedAt(physical.checkedAt)}`
      : "Vínculo encontrado, mas o saldo ainda não está pronto";

  const fullHelper = !data.full.applicable
    ? "Este produto não possui inventário Full identificado"
    : `${integer.format(data.full.accounts.length)} conta(s), sem somar os saldos entre elas`;

  const advertisedHelper = advertisedHasOffers
    ? `${integer.format(data.advertised.activeListingCount)} de ${integer.format(data.advertised.listingCount)} oferta(s) ativa(s)`
    : "Nenhum anúncio atual associado ao produto";

  const costSource = physical.effectiveCostSource === "average_cost"
    ? "Custo médio do estoque"
    : physical.effectiveCostSource === "purchase_cost"
      ? "Custo de compra cadastrado"
      : physical.effectiveCostSource === "derived_components"
        ? "Soma dos componentes do kit"
        : "Aguardando dados de custo";

  return (
    <section className="mt-8" aria-labelledby="stock-intelligence-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="stock-intelligence-title" className="text-sm font-semibold text-gray-950">
            Estoque e disponibilidade
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Estoque físico, Full separado por conta e saldo publicado
          </p>
        </div>
        <Badge variant={readiness.variant}>
          {readiness.label}
        </Badge>
      </div>

      {data.mapping.status === "missing" ? (
        <div className="mb-4 overflow-hidden rounded-2xl border border-amber-200 bg-amber-50 shadow-sm">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold text-amber-950">
                Estrutura pronta para receber o estoque físico
              </p>
              <p className="mt-1 text-xs leading-5 text-amber-800">
                O SKU ainda não foi vinculado ao UpSeller. Quando a primeira importação for feita, saldo físico, depósitos, custos e kits aparecerão aqui automaticamente.
              </p>
            </div>
            <span className="shrink-0 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
              Importação do UpSeller pendente
            </span>
          </div>
        </div>
      ) : null}

      {data.mapping.status === "conflict" ? (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
          <p className="text-sm font-semibold text-red-950">
            Mais de um SKU do UpSeller pode representar este produto
          </p>
          <p className="mt-1 text-xs leading-5 text-red-800">
            O saldo físico permanece como desconhecido até que o vínculo seja revisado. Candidatos: {data.mapping.candidates?.join(", ") ?? "não informados"}.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          eyebrow="Operação"
          label={isKit ? "Kits disponíveis" : "Estoque físico"}
          value={physicalReady ? formatQuantity(physicalAvailable) : "—"}
          helper={physicalHelper}
          tone="slate"
        />
        <MetricCard
          eyebrow="Mercado Livre"
          label="Contas no Full"
          value={data.full.applicable ? integer.format(data.full.accounts.length) : "—"}
          helper={fullHelper}
          tone="emerald"
        />
        <MetricCard
          eyebrow="Publicação"
          label="Estoque anunciado"
          value={advertisedHasOffers ? formatQuantity(data.advertised.availabilityPublished) : "—"}
          helper={advertisedHelper}
          tone="blue"
        />
        <MetricCard
          eyebrow="Financeiro"
          label="Custo efetivo"
          value={formatCurrency(effectiveCost)}
          helper={costSource}
          tone="amber"
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.05fr_1fr]">
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-gray-950">
                Leitura por origem
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Cada saldo mantém seu significado; os números não são somados entre si.
              </p>
            </div>
            <span className="rounded-lg bg-gray-50 px-2.5 py-1 text-[11px] font-medium text-gray-500 ring-1 ring-inset ring-gray-200">
              SKU {data.product.sku}
            </span>
          </div>

          <div className="mt-3">
            <AvailabilityRow
              label="Físico / UpSeller"
              description={physicalReady ? formatCheckedAt(physical.checkedAt) : "Aguardando saldo físico confiável"}
              value={physicalReady ? formatQuantity(physicalAvailable) : "Pendente"}
              state={physicalReady ? "ready" : data.mapping.status === "linked" ? "pending" : "inactive"}
            />
            {data.full.accounts.length > 0 ? data.full.accounts.map((account) => (
              <AvailabilityRow
                key={account.accountId}
                label={`Full · ${account.displayName ?? account.code ?? "Conta Mercado Livre"}`}
                description={account.checkedInventoryCount > 0
                  ? `${formatCheckedAt(account.checkedAt)} · ${integer.format(account.checkedInventoryCount)}/${integer.format(account.inventoryCount)} inventário(s)`
                  : "Aguardando a primeira leitura do Full desta conta"}
                value={account.checkedInventoryCount > 0 ? formatQuantity(account.available) : "Pendente"}
                state={account.pendingInventoryCount === 0 ? "ready" : "pending"}
              />
            )) : (
              <AvailabilityRow
                label="Fulfillment Full"
                description="Sem inventário Full associado"
                value="N/A"
                state="inactive"
              />
            )}
            <AvailabilityRow
              label="Publicado nos anúncios"
              description={advertisedHelper}
              value={advertisedHasOffers ? formatQuantity(data.advertised.availabilityPublished) : "N/A"}
              state={advertisedHasOffers ? "ready" : "inactive"}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-gray-950">
                Vínculo de estoque
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Correspondência entre o produto canônico e o UpSeller
              </p>
            </div>
            <Badge
              variant={
                data.mapping.status === "linked"
                  ? "success"
                  : data.mapping.status === "conflict"
                    ? "danger"
                    : "neutral"
              }
            >
              {data.mapping.status === "linked"
                ? "Vinculado"
                : data.mapping.status === "conflict"
                  ? "Conflito"
                  : "Sem vínculo"}
            </Badge>
          </div>

          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl bg-gray-50 p-4">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                SKU de origem
              </dt>
              <dd className="mt-2 text-sm font-semibold text-gray-950">
                {data.mapping.sourceSku ?? "Aguardando importação"}
              </dd>
            </div>
            <div className="rounded-xl bg-gray-50 p-4">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Tipo
              </dt>
              <dd className="mt-2 text-sm font-semibold text-gray-950">
                {data.mapping.sourceKind === "kit"
                  ? "Kit"
                  : data.mapping.sourceKind === "simple"
                    ? "Produto simples"
                    : "Ainda não identificado"}
              </dd>
            </div>
            <div className="rounded-xl bg-gray-50 p-4">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Saldo atual
              </dt>
              <dd className="mt-2 text-sm font-semibold text-gray-950">
                {physicalReady ? formatQuantity(physicalCurrent) : "—"}
              </dd>
            </div>
            <div className="rounded-xl bg-gray-50 p-4">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Ocupado
              </dt>
              <dd className="mt-2 text-sm font-semibold text-gray-950">
                {physicalReady ? formatQuantity(physicalOccupied) : "—"}
              </dd>
            </div>
          </dl>

          {physicalReady && lowStockThreshold !== null ? (
            <p className="mt-4 text-xs leading-5 text-gray-500">
              Referência de estoque baixo: <span className="font-semibold text-gray-700">{formatQuantity(lowStockThreshold)} unidades</span>.
            </p>
          ) : null}
        </div>
      </div>

      {warehouses.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-4">
            <p className="text-sm font-semibold text-gray-950">
              Estoque por depósito
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Saldos físicos mantidos separadamente por localização
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
                <tr>
                  <th className="px-5 py-3">Depósito</th>
                  <th className="px-5 py-3">Estante</th>
                  <th className="px-5 py-3 text-right">Disponível</th>
                  <th className="px-5 py-3 text-right">Atual</th>
                  <th className="px-5 py-3 text-right">Ocupado</th>
                  <th className="px-5 py-3 text-right">Em trânsito</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {warehouses.map((warehouse) => (
                  <tr key={warehouse.key} className="text-sm">
                    <td className="px-5 py-4 font-semibold text-gray-950">
                      {warehouse.name}
                    </td>
                    <td className="px-5 py-4 text-gray-500">
                      {warehouse.shelf ?? "—"}
                    </td>
                    <td className="px-5 py-4 text-right font-semibold text-gray-950">
                      {formatQuantity(warehouse.available)}
                    </td>
                    <td className="px-5 py-4 text-right text-gray-700">
                      {formatQuantity(warehouse.current)}
                    </td>
                    <td className="px-5 py-4 text-right text-gray-700">
                      {formatQuantity(warehouse.occupied)}
                    </td>
                    <td className="px-5 py-4 text-right text-gray-700">
                      {formatQuantity(
                        warehouse.purchaseInTransit === null && warehouse.transferInTransit === null
                          ? null
                          : (warehouse.purchaseInTransit ?? 0) + (warehouse.transferInTransit ?? 0),
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {kitComponents.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-4">
            <p className="text-sm font-semibold text-gray-950">
              Composição do kit
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Componentes usados para calcular capacidade e custo
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left">
              <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
                <tr>
                  <th className="px-5 py-3">SKU componente</th>
                  <th className="px-5 py-3 text-right">Qtd. por kit</th>
                  <th className="px-5 py-3 text-right">Custo efetivo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {kitComponents.map((component) => (
                  <tr key={component.sku} className="text-sm">
                    <td className="px-5 py-4 font-semibold text-gray-950">
                      {component.sku}
                    </td>
                    <td className="px-5 py-4 text-right text-gray-700">
                      {formatQuantity(component.requiredQuantity)}
                    </td>
                    <td className="px-5 py-4 text-right font-semibold text-gray-950">
                      {formatCurrency(component.effectiveCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {data.full.accounts.length > 0 ? (
        <div className="mt-4 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-4">
            <div>
              <p className="text-sm font-semibold text-gray-950">
                Full por conta
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Cobertura dos inventários vinculados em cada operação
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left">
              <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
                <tr>
                  <th className="px-5 py-3">Conta</th>
                  <th className="px-5 py-3 text-right">Disponível</th>
                  <th className="px-5 py-3 text-right">Total</th>
                  <th className="px-5 py-3 text-right">Indisponível</th>
                  <th className="px-5 py-3 text-right">Cobertura</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.full.accounts.map((account) => (
                  <tr key={account.accountId} className="text-sm">
                    <td className="px-5 py-4">
                      <p className="font-semibold text-gray-950">
                        {account.displayName ?? account.code ?? "Conta Mercado Livre"}
                      </p>
                      {account.code ? (
                        <p className="mt-1 text-xs text-gray-400">
                          {account.code}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-5 py-4 text-right font-semibold text-gray-950">
                      {formatQuantity(account.available)}
                    </td>
                    <td className="px-5 py-4 text-right text-gray-700">
                      {formatQuantity(account.total)}
                    </td>
                    <td className="px-5 py-4 text-right text-gray-700">
                      {formatQuantity(account.notAvailable)}
                    </td>
                    <td className="px-5 py-4 text-right text-gray-500">
                      {integer.format(account.checkedInventoryCount)}/{integer.format(account.inventoryCount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
