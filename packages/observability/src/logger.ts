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

import { redactSecretText, SENSITIVE_KEY_NAMES } from "./sensitive.js";

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = new RegExp(SENSITIVE_KEY_NAMES.join("|"), "i");

/**
 * Redige um VALOR qualquer: string passa pelas regras de texto, objeto e array
 * descem, o resto (número, booleano, nulo) volta como veio.
 */
function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecretText(value, REDACTED);

  if (Array.isArray(value)) return value.map(redactValue);

  if (value !== null && typeof value === "object") return redact(value as LogContext);

  return value;
}

/**
 * Duas camadas, e a segunda nasceu em D-330.
 *
 * 1. **Por NOME de chave** (`docs/ARCHITECTURE.md` secao 18): `access_token`,
 *    `authorization`… viram `[REDACTED]` inteiros, seja qual for o valor. É o
 *    único filtro que continua funcionando quando alguém despeja um objeto
 *    inteiro por engano.
 * 2. **Por VALOR**, em toda string: a camada 1 deixava passar `{ reason:
 *    error.message }`, e é por esse campo que a mensagem de um cliente de
 *    terceiro chega aqui. Vale para `message` e `stack` de um `Error`, que
 *    `serializeError` já transformou em objeto antes de chegar a esta função.
 *
 * Arrays também descem agora — antes uma lista de strings passava intacta.
 */
export function redact(context: LogContext): LogContext {
  const result: LogContext = {};

  for (const [key, value] of Object.entries(context)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(value);
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
