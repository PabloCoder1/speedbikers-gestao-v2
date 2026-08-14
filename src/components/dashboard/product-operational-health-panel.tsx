import type {
  getProductListings,
} from "@/features/dashboard/get-product-listings";


type ProductListings =
  Awaited<
    ReturnType<
      typeof getProductListings
    >
  >;


type ProductOperationalHealthPanelProps = {
  data:
    ProductListings;
};


const currency =
  new Intl.NumberFormat(
    "pt-BR",
    {
      style:
        "currency",

      currency:
        "BRL",
    },
  );


const integer =
  new Intl.NumberFormat(
    "pt-BR",
  );


const percent =
  new Intl.NumberFormat(
    "pt-BR",
    {
      maximumFractionDigits:
        1,
    },
  );


/*
 * Thresholds internos e iniciais deste sistema.
 * Não representam limites oficiais do Mercado Livre
 * e devem virar configuração no futuro.
 */
const HEALTH_ATTENTION_THRESHOLD =
  0.8;

const PRICE_SPREAD_ATTENTION_THRESHOLD_PERCENT =
  20;


type OperationalStatus =
  | "critical"
  | "warning"
  | "healthy";


type OperationalSignal = {
  level:
    | "critical"
    | "warning";

  message: string;
};


const STATUS_LABELS: Record<
  OperationalStatus,
  string
> = {
  critical:
    "Crítico",

  warning:
    "Atenção",

  healthy:
    "Saudável",
};


const STATUS_CLASSES: Record<
  OperationalStatus,
  string
> = {
  critical:
    "bg-red-50 text-red-700",

  warning:
    "bg-amber-50 text-amber-700",

  healthy:
    "bg-emerald-50 text-emerald-700",
};


function buildSignals(
  data: ProductListings,
): OperationalSignal[] {
  const {
    listings,
    summary,
  } = data;

  const signals: OperationalSignal[] =
    [];


  if (
    listings.length >
    0 &&
    summary.activeOffers ===
    0
  ) {
    signals.push({
      level:
        "critical",

      message:
        "Nenhuma oferta ativa",
    });
  }


  const activeZeroStockOffers =
    listings.filter(
      (listing) =>
        listing.status ===
        "active" &&
        listing
          .availableQuantity ===
        0,
    ).length;

  if (
    activeZeroStockOffers >
    0
  ) {
    signals.push({
      level:
        "critical",

      message: `${activeZeroStockOffers} oferta(s) ativa(s) sem estoque`,
    });
  }


  if (
    summary.averageHealth !==
    null &&
    summary.averageHealth <
    HEALTH_ATTENTION_THRESHOLD
  ) {
    signals.push({
      level:
        "warning",

      message: `Health médio abaixo de ${HEALTH_ATTENTION_THRESHOLD.toFixed(
        2,
      )}`,
    });
  }


  if (
    summary.priceSpreadPercent !==
    null &&
    summary.priceSpreadPercent >
    PRICE_SPREAD_ATTENTION_THRESHOLD_PERCENT
  ) {
    signals.push({
      level:
        "warning",

      message: `Diferença de preço entre ofertas acima de ${PRICE_SPREAD_ATTENTION_THRESHOLD_PERCENT}%`,
    });
  }


  return signals;
}


function classifyStatus(
  signals: OperationalSignal[],
): OperationalStatus {
  if (
    signals.some(
      (signal) =>
        signal.level ===
        "critical",
    )
  ) {
    return "critical";
  }

  if (
    signals.some(
      (signal) =>
        signal.level ===
        "warning",
    )
  ) {
    return "warning";
  }

  return "healthy";
}


export function ProductOperationalHealthPanel({
  data,
}: ProductOperationalHealthPanelProps) {
  const {
    summary,
  } = data;


  if (
    data.listings.length ===
    0
  ) {
    return (
      <section className="mt-8">

        <div className="mb-4">

          <h2 className="text-sm font-semibold text-gray-950">
            Saúde operacional
          </h2>

          <p className="mt-1 text-xs text-gray-500">
            Classificação determinística com base no estado atual dos anúncios
          </p>

        </div>


        <div className="rounded-2xl border border-gray-200 bg-white p-10 text-center">

          <p className="text-sm font-medium text-gray-700">
            Sem anúncios para avaliar.
          </p>

        </div>

      </section>
    );
  }


  const signals =
    buildSignals(
      data,
    );

  const status =
    classifyStatus(
      signals,
    );


  return (
    <section className="mt-8">

      <div className="mb-4">

        <h2 className="text-sm font-semibold text-gray-950">
          Saúde operacional
        </h2>

        <p className="mt-1 text-xs text-gray-500">
          Classificação determinística com base no estado atual dos anúncios
        </p>

      </div>


      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">

        <div className="flex flex-wrap items-center justify-between gap-3">

          <p className="text-xs font-medium text-gray-500">
            Classificação atual
          </p>

          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_CLASSES[status]}`}
          >
            {
              STATUS_LABELS[
                status
              ]
            }
          </span>

        </div>


        {signals.length >
        0 ? (

          <ul className="mt-3 space-y-1.5">

            {signals.map(
              (
                signal,
                index,
              ) => (

                <li
                  key={
                    index
                  }
                  className="flex items-center gap-2 text-xs text-gray-600"
                >

                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      signal.level ===
                      "critical"
                        ? "bg-red-500"
                        : "bg-amber-500"
                    }`}
                  />

                  {
                    signal.message
                  }

                </li>

              ),
            )}

          </ul>

        ) : (

          <p className="mt-3 text-xs text-gray-500">
            Nenhum sinal de atenção identificado.
          </p>

        )}


        <div className="mt-5 grid gap-6 border-t border-black/5 pt-5 sm:grid-cols-3">

          {/* ===============================================
              PRICE
          =============================================== */}

          <div>

            <p className="text-xs font-medium text-gray-500">
              Preço
            </p>


            {summary.minimumPrice !==
            null &&
            summary.maximumPrice !==
            null ? (

              <>

                <p className="mt-2 text-2xl font-bold tracking-tight text-gray-950">
                  {
                    currency.format(
                      summary.minimumPrice,
                    )
                  }
                </p>


                <p className="mt-1 text-xs text-gray-500">
                  até{" "}
                  {
                    currency.format(
                      summary.maximumPrice,
                    )
                  }
                </p>


                {summary.priceSpreadPercent !==
                null ? (

                  <p className="mt-2 text-xs text-gray-500">
                    Diferença:{" "}

                    <span className="font-semibold text-gray-700">
                      {
                        percent.format(
                          summary.priceSpreadPercent,
                        )
                      }
                      %
                    </span>
                  </p>

                ) : null}

              </>

            ) : (

              <p className="mt-2 text-sm text-gray-500">
                Sem preço disponível
              </p>

            )}

          </div>


          {/* ===============================================
              HEALTH
          =============================================== */}

          <div>

            <p className="text-xs font-medium text-gray-500">
              Health
            </p>


            {summary.averageHealth !==
            null ? (

              <>

                <p className="mt-2 text-2xl font-bold tracking-tight text-gray-950">
                  {
                    summary.averageHealth.toFixed(
                      2,
                    )
                  }
                </p>


                <p className="mt-1 text-xs text-gray-500">
                  health médio
                </p>




                {summary.minimumHealth !==
                null ? (


                  <p className="mt-2 text-xs text-gray-500">
                    Menor health:{" "}


                    <span className="font-semibold text-gray-700">
                      {
                        summary.minimumHealth.toFixed(
                          2,
                        )
                      }
                    </span>
                  </p>


                ) : null}


              </>


            ) : (


              <p className="mt-2 text-sm text-gray-500">
                Sem health disponível
              </p>


            )}


          </div>




          {/* ===============================================
              DISTRIBUTION
          =============================================== */}


          <div>


            <p className="text-xs font-medium text-gray-500">
              Distribuição
            </p>




            <p className="mt-2 text-2xl font-bold tracking-tight text-gray-950">
              {
                integer.format(
                  summary.accounts,
                )
              }
            </p>




            <p className="mt-1 text-xs text-gray-500">
              contas com anúncio
            </p>




            <p className="mt-2 text-xs text-gray-500">
              {
                integer.format(
                  summary.catalogOffers,
                )
              }{" "}
              oferta(s) em catálogo
            </p>


          </div>


        </div>




        {/* ===============================================
            OBSERVATION
        =============================================== */}


        <div className="mt-5 border-t border-black/5 pt-4">


          <p className="text-[11px] leading-5 text-gray-500">
            A classificação acima é determinística e baseada apenas no estado atual dos anúncios. Ela ainda não representa diagnóstico de causa sobre aumento ou queda de vendas.
          </p>


        </div>


      </div>


    </section>
  );
}
