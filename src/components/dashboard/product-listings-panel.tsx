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

            <table className="w-full min-w-[1100px] text-left">

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
                    Preço
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


                      <td className="px-5 py-4 text-right font-semibold text-gray-950">

                        {listing.price !==
                        null
                          ? currency.format(
                              listing.price,
                            )
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
