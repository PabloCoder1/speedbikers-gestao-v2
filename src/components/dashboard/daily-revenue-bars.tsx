type DailyRevenue = {
  date: string;

  grossRevenue: number;

  paidOrders: number;

  unitsSold: number;
};


type DailyRevenueBarsProps = {
  days:
    DailyRevenue[];
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


const dateFormatter =
  new Intl.DateTimeFormat(
    "pt-BR",
    {
      day:
        "2-digit",

      month:
        "2-digit",

      timeZone:
        "UTC",
    },
  );


function formatDate(
  dateKey: string,
) {
  return dateFormatter.format(
    new Date(
      `${dateKey}T12:00:00.000Z`,
    ),
  );
}


export function DailyRevenueBars({
  days,
}: DailyRevenueBarsProps) {
  const maxRevenue =
    Math.max(
      ...days.map(
        (day) =>
          day.grossRevenue,
      ),
      1,
    );


  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div>
        <p className="text-sm font-semibold text-gray-950">
          Evolução diária
        </p>

        <p className="mt-1 text-xs text-gray-500">
          Faturamento dos últimos 14 dias
        </p>
      </div>


      <div className="mt-6 space-y-3">
        {days.map(
          (day) => {
            const width =
              day.grossRevenue >
              0
                ? Math.max(
                    2,
                    (
                      day.grossRevenue /
                      maxRevenue
                    ) * 100,
                  )
                : 0;


            return (
              <div
                key={
                  day.date
                }
                className="grid grid-cols-[48px_1fr_110px] items-center gap-3"
              >
                <span className="text-xs font-medium text-gray-500">
                  {formatDate(
                    day.date,
                  )}
                </span>


                <div className="h-7 overflow-hidden rounded-lg bg-gray-100">
                  <div
                    className="h-full rounded-lg bg-gray-950 transition-all"
                    style={{
                      width:
                        `${width}%`,
                    }}
                  />
                </div>


                <div className="text-right">
                  <p className="text-xs font-semibold text-gray-900">
                    {currency.format(
                      day.grossRevenue,
                    )}
                  </p>

                  <p className="text-[11px] text-gray-400">
                    {
                      day.unitsSold
                    }{" "}
                    un.
                  </p>
                </div>
              </div>
            );
          },
        )}
      </div>
    </div>
  );
}