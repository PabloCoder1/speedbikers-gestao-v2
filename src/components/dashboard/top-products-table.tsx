type TopProduct = {
  position: number;

  productId: string;

  sku: string;

  name: string | null;

  ordersCount: number;

  unitsSold: number;

  grossRevenue: number;

  saleFees: number;

  netAfterSaleFee: number;

  averageUnitPrice: number;
};


type TopProductsTableProps = {
  products:
    TopProduct[];
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


export function TopProductsTable({
  products,
}: TopProductsTableProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 p-5">
        <p className="text-sm font-semibold text-gray-950">
          Top SKUs
        </p>

        <p className="mt-1 text-xs text-gray-500">
          Ranking por faturamento nos últimos 30 dias
        </p>
      </div>


      {products.length ===
      0 ? (
        <div className="p-8 text-center text-sm text-gray-500">
          Ainda não há vendas suficientes para formar o ranking.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">
              <tr>
                <th className="px-5 py-3">
                  #
                </th>

                <th className="px-5 py-3">
                  Produto
                </th>

                <th className="px-5 py-3 text-right">
                  Pedidos
                </th>

                <th className="px-5 py-3 text-right">
                  Unidades
                </th>

                <th className="px-5 py-3 text-right">
                  Faturamento
                </th>

                <th className="px-5 py-3 text-right">
                  Após taxa
                </th>
              </tr>
            </thead>


            <tbody className="divide-y divide-gray-100">
              {products.map(
                (
                  product,
                ) => (
                  <tr
                    key={
                      product.productId
                    }
                    className="text-sm"
                  >
                    <td className="px-5 py-4 font-semibold text-gray-400">
                      {
                        product.position
                      }
                    </td>


                    <td className="max-w-[360px] px-5 py-4">
                      <p className="font-semibold text-gray-950">
                        {
                          product.sku
                        }
                      </p>

                      <p className="mt-1 truncate text-xs text-gray-500">
                        {product.name ??
                          "Produto sem nome"}
                      </p>
                    </td>


                    <td className="px-5 py-4 text-right font-medium text-gray-700">
                      {
                        product.ordersCount
                      }
                    </td>


                    <td className="px-5 py-4 text-right font-medium text-gray-700">
                      {
                        product.unitsSold
                      }
                    </td>


                    <td className="px-5 py-4 text-right font-semibold text-gray-950">
                      {currency.format(
                        product.grossRevenue,
                      )}
                    </td>


                    <td className="px-5 py-4 text-right text-gray-700">
                      {currency.format(
                        product.netAfterSaleFee,
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}