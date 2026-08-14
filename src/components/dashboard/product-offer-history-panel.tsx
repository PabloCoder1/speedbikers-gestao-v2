import Link from "next/link";

import type {
  OfferHistoryChange,
  getProductOfferHistory,
} from "@/features/dashboard/get-product-offer-history";


type ProductOfferHistory =
  Awaited<
    ReturnType<
      typeof getProductOfferHistory
    >
  >;


type ProductOfferHistoryPanelProps = {
  data:
    ProductOfferHistory;
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


const dateTime =
  new Intl.DateTimeFormat(
    "pt-BR",
    {
      day:
        "2-digit",

      month:
        "2-digit",

      year:
        "numeric",

      hour:
        "2-digit",

      minute:
        "2-digit",

      timeZone:
        "America/Sao_Paulo",
    },
  );


const CHANGE_LABELS: Record<
  OfferHistoryChange["type"],
  string
> = {
  price_changed:
    "Preço mudou",

  stock_changed:
    "Estoque mudou",

  stock_zeroed:
    "Estoque zerou",

  stock_restored:
    "Estoque voltou",

  status_changed:
    "Status mudou",

  health_changed:
    "Health mudou",

  catalog_changed:
    "Catálogo mudou",

  title_changed:
    "Título mudou",

  listing_no_longer_current:
    "Anúncio deixou de ser o vigente",
};


function formatValue(
  change: OfferHistoryChange,
  value: unknown,
) {
  switch (change.type) {
    case "price_changed":
      return value !== null
        ? currency.format(
            value as number,
          )
        : "—";

    case "stock_changed":
    case "stock_zeroed":
    case "stock_restored":
      return integer.format(
        value as number,
      );

    case "health_changed":
      return value !== null
        ? (
            value as number
          ).toFixed(2)
        : "—";

    case "catalog_changed":
      return value
        ? "Sim"
        : "Não";

    case "listing_no_longer_current":
      return value
        ? "Vigente"
        : "Não vigente";

    case "status_changed":
    case "title_changed":
      return (
        (value as
          | string
          | null) ?? "—"
      );

    default:
      return "—";
  }
}


export function ProductOfferHistoryPanel({
  data,
}: ProductOfferHistoryPanelProps) {
  const {
    events,
  } = data;


  return (
    <section className="mt-8">

      <div className="mb-4">

        <h2 className="text-sm font-semibold text-gray-950">
          Histórico operacional
        </h2>

        <p className="mt-1 text-xs text-gray-500">
          Mudanças de estado observadas nos anúncios e variações deste SKU
        </p>

      </div>


      {events.length ===
      0 ? (

        <div className="rounded-2xl border border-gray-200 bg-white p-10 text-center">

          <p className="text-sm font-medium text-gray-700">
            Nenhum evento registrado ainda.
          </p>

          <p className="mt-2 text-xs text-gray-500">
            O histórico é construído a cada sincronização de anúncios que capturar uma mudança de estado.
          </p>

        </div>

      ) : (

        <div className="space-y-3">

          {events.map(
            (event) => (

              <article
                key={
                  event.snapshotId
                }
                className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
              >

                <div className="flex flex-wrap items-start justify-between gap-3">

                  <div>

                    <p className="text-xs text-gray-400">
                      {
                        dateTime.format(
                          new Date(
                            event.capturedAt,
                          ),
                        )
                      }
                    </p>


                    <p className="mt-1 text-sm font-semibold text-gray-950">
                      {event.title ??
                        "Sem título"}
                    </p>


                    <p className="mt-1 text-xs text-gray-500">

                      <Link
                        href={`/conta/${event.accountCode}`}
                        className="font-medium text-gray-700 transition hover:text-gray-950"
                      >
                        {
                          event.accountName
                        }
                      </Link>

                      {" · "}

                      {
                        event.itemId
                      }

                      {event.variationId
                        ? ` · Variação ${event.variationId}`
                        : ""}

                      {event.sellerSku
                        ? ` · SKU ${event.sellerSku}`
                        : ""}

                    </p>

                  </div>


                  <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600">
                    {event.offerScope ===
                    "variation"
                      ? "Variação"
                      : "Anúncio"}
                  </span>

                </div>


                <div className="mt-3 space-y-2 text-xs text-gray-600">

                  {event.changes
                    .length >
                  0 ? (

                    event.changes.map(
                      (
                        change,
                      ) => (

                        <div
                          key={
                            change.type
                          }
                          className="flex flex-wrap items-center gap-2"
                        >

                          <span className="font-medium text-gray-700">
                            {
                              CHANGE_LABELS[
                                change
                                  .type
                              ]
                            }
                          </span>


                          <div className="flex items-center gap-2">

                            <span>
                              {
                                formatValue(
                                  change,
                                  change.from,
                                )
                              }
                            </span>


                            <span className="opacity-40">
                              →
                            </span>


                            <span className="font-semibold">
                              {
                                formatValue(
                                  change,
                                  change.to,
                                )
                              }
                            </span>


                          </div>


                        </div>

                      ),
                    )

                  ) : (

                    <span className="text-xs opacity-70">
                      Estado inicial registrado
                    </span>

                  )}

                </div>


                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-gray-100 pt-3 text-[11px] text-gray-400">


                  <span>
                    Status:{" "}
                    {
                      event.status ??
                      "—"
                    }
                  </span>


                  <span>
                    Estoque:{" "}
                    {
                      integer.format(
                        event.availableQuantity,
                      )
                    }
                  </span>


                  <span>
                    Preço:{" "}
                    {event.price !==
                    null
                      ? currency.format(
                          event.price,
                        )
                      : "—"}
                  </span>


                  <span>
                    Health:{" "}
                    {event.health !==
                    null
                      ? event.health.toFixed(
                          2,
                        )
                      : "—"}
                  </span>


                </div>


              </article>


            ),
          )}


        </div>

      )}


      <p className="mt-3 text-[11px] leading-5 text-gray-400">
        Este histórico mostra mudanças observadas. Ele ainda não afirma que uma alteração causou aumento ou queda nas vendas.
      </p>


    </section>
  );
}
