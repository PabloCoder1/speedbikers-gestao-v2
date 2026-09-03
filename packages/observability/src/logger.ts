/**
 * Log estruturado em JSON de uma linha.
 *
 * O Cloud Run encaminha stdout para o Cloud Logging, que interpreta `severity`
 * e `message` quando a linha é JSON válido. Escrever qualquer outra coisa
 * transforma o log em texto solto e perde filtro e alerta.
 */

export type LogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export type LogContext = Record<string, unknown>;

export type LogSink = (line: string) => void;

export interface Logger {
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
  /** Deriva um logger que carrega contexto fixo, como `request_id` ou `job_id`. */
  child: (context: LogContext) => Logger;
}

export interface LoggerOptions {
  sink?: LogSink;
  now?: () => Date;
}

const REDACTED = "[REDACTED]";

/**
 * Chaves cujo valor nunca pode chegar ao log.
 *
 * `docs/ARCHITECTURE.md` secao 18: token do Mercado Livre nunca em log, nem
 * parcialmente. Redigir por nome de chave é o único filtro que continua
 * funcionando quando alguém despeja um objeto inteiro por engano.
 */
// Exportada (D-232) porque a tela tem o MESMO problema em texto: o sanitizador
// de `apps/web/lib/sanitize.ts` monta o seu regex a partir desta lista, em vez
// de manter uma segunda lista de "parece segredo" que divergiria da primeira.
export const SENSITIVE_KEY_NAMES: readonly string[] = [
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "api[-_]?key",
  "credential",
  "cookie",
];

const SENSITIVE_KEY = new RegExp(SENSITIVE_KEY_NAMES.join("|"), "i");

export function redact(context: LogContext): LogContext {
  const result: LogContext = {};

  for (const [key, value] of Object.entries(context)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = REDACTED;
      continue;
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redact(value as LogContext);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  return value;
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function createLogger(base: LogContext = {}, options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? ((): Date => new Date());

  function write(severity: LogSeverity, message: string, context: LogContext = {}): void {
    const combined: LogContext = { ...base, ...context };

    // Serializar ANTES de redigir: `name`, `message` e `stack` de um Error não
    // são enumeráveis, então percorrê-lo como objeto comum devolve `{}` e o
    // erro some do log exatamente quando ele importa.
    if ("error" in combined) {
      combined.error = serializeError(combined.error);
    }

    const merged = redact(combined);

    sink(
      JSON.stringify({
        severity,
        message,
        timestamp: now().toISOString(),
        ...merged,
      }),
    );
  }

  return {
    debug: (message, context) => {
      write("DEBUG", message, context);
    },
    info: (message, context) => {
      write("INFO", message, context);
    },
    warn: (message, context) => {
      write("WARNING", message, context);
    },
    error: (message, context) => {
      write("ERROR", message, context);
    },
    child: (context) => createLogger({ ...base, ...context }, options),
  };
}
