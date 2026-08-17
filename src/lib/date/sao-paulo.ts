const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SAO_PAULO_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SAO_PAULO_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function formatterParts(formatter: Intl.DateTimeFormat, value: Date) {
  return new Map<string, string>(
    formatter.formatToParts(value).map((part) => [part.type, part.value]),
  );
}

function parseDateKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Data local invalida: ${value}.`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Data local invalida: ${value}.`);
  }
  return { timestamp };
}

function timeZoneOffsetMilliseconds(value: Date) {
  const parts = formatterParts(dateTimePartsFormatter, value);
  const values = ["year", "month", "day", "hour", "minute", "second"]
    .map((key) => Number(parts.get(key)));
  if (values.some(Number.isNaN)) {
    throw new Error("Nao foi possivel resolver o fuso horario de Sao Paulo.");
  }
  const [year, month, day, hour, minute, second] = values;
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const instantWithoutMilliseconds = Math.floor(value.getTime() / 1000) * 1000;
  return localAsUtc - instantWithoutMilliseconds;
}

export function saoPauloDateKey(value: Date | string = new Date()) {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new Error("Instante invalido para determinar a data de Sao Paulo.");
  }
  const parts = formatterParts(dateKeyFormatter, date);
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (!year || !month || !day) {
    throw new Error("Nao foi possivel determinar a data de Sao Paulo.");
  }
  return `${year}-${month}-${day}`;
}

export function shiftSaoPauloDateKey(value: string, days: number) {
  const { timestamp } = parseDateKey(value);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

export function saoPauloStartOfDayIso(value: string) {
  const { timestamp: localMidnightAsUtc } = parseDateKey(value);
  let resolvedTimestamp = localMidnightAsUtc;

  // A segunda passagem cobre mudancas historicas de horario de verao.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = timeZoneOffsetMilliseconds(new Date(resolvedTimestamp));
    const candidate = localMidnightAsUtc - offset;
    if (candidate === resolvedTimestamp) break;
    resolvedTimestamp = candidate;
  }
  return new Date(resolvedTimestamp).toISOString();
}

export function nextSaoPauloDayStartIso(value: Date | string) {
  return saoPauloStartOfDayIso(
    shiftSaoPauloDateKey(saoPauloDateKey(value), 1),
  );
}

export { SAO_PAULO_TIME_ZONE };
