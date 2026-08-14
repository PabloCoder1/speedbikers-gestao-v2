import Link from "next/link";

import type {
  getProductListings,
} from "@/features/dashboard/get-product-listings";


type ProductListings =
  Awaited<
    ReturnType<
      typeof getProductListings
    >
  >;


type ProductListingsPanelProps = {
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


const PROMOTION_LABELS: Record<
  string,
  string
> = {
  SMART: "Smart",
  SELLER_CAMPAIGN: "Campanha",
  PRICE_DISCOUNT: "Desconto",
  DEAL: "Oferta",
  MARKETPLACE_CAMPAIGN: "Campanha ML",
  LIGHTNING: "Relâmpago",
};


function promotionLabel(
  promotionType:
    | string
    | null,
) {
  if (!promotionType) {
    return "Promoção ativa";
  }

  return (
    PROMOTION_LABELS[
      promotionType
    ] ??
    promotionType
  );
}


function statusLabel(
  status:
    | string
    | null,
) {
  switch (status) {
    case "active":
      return "Ativo";

    case "paused":
      return "Pausado";

    case "closed":
      return "Encerrado";

    default:
      return (
        status ??
        "Desconhecido"
      );
  }
}


function statusClass(
  status:
    | string
    | null,
) {
  switch (status) {
    case "active":
      return "bg-emerald-50 text-emerald-700";

    case "paused":
      return "bg-amber-50 text-amber-700";

    default:
      return "bg-gray-100 text-gray-600";
  }
}


export function ProductListingsPanel({
  data,
}: ProductListingsPanelProps) {
  const {
    listings,
    summary,
  } = data;

  const eligiblePriceOffers =
    summary.validatedPriceOffers +
    summary.pendingPriceOffers;

  const lowestEffectiveListingIds =
    new Set(
      summary.lowestEffectiveListingIds,
    );


  return (
    <section className="mt-8">

      <div className="mb-4">

        <h2 className="text-sm font-semibold text-gray-950">
          Anúncios deste SKU
        </h2>

        <p className="mt-1 text-xs text-gray-500">
          Estado operacional atual dos anúncios e variações vinculados ao produto
        </p>

      </div>


      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">

        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500">
            MLBs
          </p>

          <p className="mt-1 text-xl font-bold text-gray-950">
            {
              integer.format(
                summary.mlbs,
              )
            }
          </p>
        </div>


        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500">
            Ofertas / variações
          </p>

          <p className="mt-1 text-xl font-bold text-gray-950">
            {
              integer.format(
                summary.offers,
              )
            }
          </p>
        </div>


        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500">
            Ativas
          </p>

          <p className="mt-1 text-xl font-bold text-gray-950">
            {
              integer.format(
                summary.activeOffers,
              )
            }
          </p>
        </div>


        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500">
            Estoque anunciado
          </p>

          <p className="mt-1 text-xl font-bold text-gray-950">
            {
              integer.format(
                summary.advertisedStock,
              )
            }
          </p>
        </div>


        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500">
            Contas
          </p>

          <p className="mt-1 text-xl font-bold text-gray-950">
            {
              integer.format(
                summary.accounts,
              )
            }
          </p>
        </div>

      </div>


      {summary.pendingPriceOffers > 0 ||
      summary.variationPriceOffers > 0 ? (

        <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">

          {summary.pendingPriceOffers > 0 ? (

            <p>
              Preço final validado em{" "}
              <span className="font-semibold text-gray-800">
                {integer.format(summary.validatedPriceOffers)} de{" "}
                {integer.format(eligiblePriceOffers)}
              </span>{" "}
              anúncios elegíveis.
            </p>

          ) : null}


          {summary.variationPriceOffers > 0 ? (

            <p className={summary.pendingPriceOffers > 0 ? "mt-1" : undefined}>
              {integer.format(summary.variationPriceOffers)}{" "}
              {summary.variationPriceOffers === 1
                ? "variação utiliza"
                : "variações utilizam"}{" "}
              preço próprio sem validação promocional.
            </p>

          ) : null}

        </div>

      ) : null}


      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">

        {listings.length ===
        0 ? (

          <div className="p-10 text-center">

            <p className="text-sm font-medium text-gray-700">
              Nenhum anúncio atual vinculado a este SKU.
            </p>

            <p className="mt-2 text-xs text-gray-500">
              Isso também pode indicar que a sincronização completa de anúncios ainda não terminou.
            </p>

          </div>

        ) : (

          <div className="overflow-x-auto">

            <table className="w-full min-w-[1320px] text-left">

              <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">

                <tr>

                  <th className="px-5 py-3">
                    Conta
                  </th>

                  <th className="px-5 py-3">
                    Anúncio
                  </th>

                  <th className="px-5 py-3">
                    Status
                  </th>

                  <th className="px-5 py-3 text-right">
                    Preço base
                  </th>

                  <th className="px-5 py-3 text-right">
                    Preço final
                  </th>

                  <th className="px-5 py-3 text-right">
                    Desconto
                  </th>

                  <th className="px-5 py-3 text-right">
                    Estoque
                  </th>

                  <th className="px-5 py-3 text-right">
                    Vendidos
                  </th>

                  <th className="px-5 py-3 text-right">
                    Health
                  </th>

                  <th className="px-5 py-3 text-center">
                    Catálogo
                  </th>

                </tr>

              </thead>


              <tbody className="divide-y divide-gray-100">

                {listings.map(
                  (listing) => (

                    <tr
                      key={
                        listing.key
                      }
                      className="text-sm transition hover:bg-gray-50"
                    >

                      <td className="px-5 py-4">

                        <Link
                          href={`/conta/${listing.accountCode}`}
                          className="font-semibold text-gray-950 transition hover:text-gray-500"
                        >
                          {
                            listing.accountName
                          }
                        </Link>

                      </td>


                      <td className="max-w-[430px] px-5 py-4">

                        {listing.permalink ? (

                          <a
                            href={
                              listing.permalink
                            }
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold text-gray-950 transition hover:text-gray-500"
                          >
                            {
                              listing.itemId
                            }
                          </a>

                        ) : (

                          <p className="font-semibold text-gray-950">
                            {
                              listing.itemId
                            }
                          </p>

                        )}


                        {listing.variationId ? (

                          <p className="mt-1 text-[11px] text-gray-400">
                            Variação{" "}
                            {
                              listing.variationId
                            }
                          </p>

                        ) : null}


                        <p className="mt-1 truncate text-xs text-gray-500">
                          {
                            listing.title ??
                            "Sem título"
                          }
                        </p>


                        {listing.sellerSku ? (

                          <p className="mt-1 text-[11px] text-gray-400">
                            SKU{" "}
                            {
                              listing.sellerSku
                            }
                          </p>

                        ) : null}

                      </td>


                      <td className="px-5 py-4">

                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(
                            listing.status,
                          )}`}
                        >
                          {
                            statusLabel(
                              listing.status,
                            )
                          }
                        </span>

                      </td>


                      <td className="px-5 py-4 text-right text-gray-600">

                        {listing.priceReady &&
                        listing.basePrice !==
                        null ? (

                          <span
                            className={
                              listing.effectivePrice !== null &&
                              listing.basePrice > listing.effectivePrice
                                ? "line-through decoration-gray-300"
                                : "font-medium text-gray-800"
                            }
                          >
                            {
                              currency.format(
                                listing.basePrice,
                              )
                            }
                          </span>

                        ) : "—"}

                      </td>


                      <td className="px-5 py-4 text-right">

                        <div className="flex items-center justify-end gap-2">

                          <span
                            className={
                              listing.priceReady
                                ? "font-bold text-gray-950"
                                : "font-semibold text-gray-700"
                            }
                          >
                            {listing.displayPrice !==
                            null
                              ? currency.format(
                                  listing.displayPrice,
                                )
                              : "—"}
                          </span>


                          {listing.priceReady &&
                          lowestEffectiveListingIds.has(
                            listing.listingId,
                          ) ? (

                            <span className="whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600">
                              Menor final
                            </span>

                          ) : null}

                        </div>


                        {listing.priceReady &&
                        listing.hasActivePromotion ? (

                          <span
                            title={listing.promotionName ?? undefined}
                            className="mt-1 inline-flex max-w-[150px] truncate rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700"
                          >
                            {
                              promotionLabel(
                                listing.promotionType,
                              )
                            }
                          </span>

                        ) : listing.priceScope ===
                          "listing_pending" ? (

                            <p className="mt-1 text-[10px] font-normal text-gray-400">
                              Aguardando validação
                            </p>

                          ) : listing.priceScope ===
                            "variation_unvalidated" ? (

                            <p
                              title="Preço promocional ainda não validado para variações"
                              className="mt-1 text-[10px] font-normal text-gray-400"
                            >
                              Preço da variação
                            </p>

                          ) : null}

                      </td>


                      <td className="px-5 py-4 text-right font-medium text-gray-700">

                        {listing.discountPercent !==
                        null
                          ? `-${percent.format(
                              listing.discountPercent,
                            )}%`
                          : "—"}

                      </td>


                      <td className="px-5 py-4 text-right text-gray-700">

                        {
                          integer.format(
                            listing.availableQuantity,
                          )
                        }

                      </td>


                      <td className="px-5 py-4 text-right text-gray-700">

                        {
                          integer.format(
                            listing.soldQuantity,
                          )
                        }

                      </td>


                      <td className="px-5 py-4 text-right text-gray-700">

                        {listing.health !==
                        null
                          ? listing.health
                              .toFixed(
                                2,
                              )
                          : "—"}

                      </td>


                      <td className="px-5 py-4 text-center">

                        {listing.catalogListing
                          ? (
                              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                                Sim
                              </span>
                            )
                          : "—"}

                      </td>

                    </tr>

                  ),
                )}

              </tbody>

            </table>

          </div>

        )}

      </div>


      <p className="mt-3 text-[11px] leading-5 text-gray-400">
        Estoque anunciado representa a soma das quantidades publicadas nos anúncios/variações e não deve ser interpretado, por enquanto, como estoque físico consolidado.
      </p>

    </section>
  );
}
