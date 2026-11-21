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
const CIRCULAR = "[Circular]";

const SENSITIVE_KEY = new RegExp(SENSITIVE_KEY_NAMES.join("|"), "i");

/**
 * Redige um VALOR qualquer: string passa pelas regras de texto, `Error` é
 * serializado em qualquer profundidade (com `cause` se houver), objetos e
 * arrays descem com guarda contra ciclos, o resto volta como veio (D-779).
 */
function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecretText(value, REDACTED);

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    try {
      return {
        name: value.name,
        message: redactSecretText(value.message, REDACTED),
        ...(value.stack === undefined ? {} : { stack: redactSecretText(value.stack, REDACTED) }),
        ...(value.cause === undefined ? {} : { cause: redactValue(value.cause, seen) }),
      };
    } finally {
      seen.delete(value);
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    try {
      return value.map((item) => redactValue(item, seen));
    } finally {
      seen.delete(value);
    }
  }

  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    try {
      return redactObject(value as LogContext, seen);
    } finally {
      seen.delete(value);
    }
  }

  return value;
}

function redactObject(context: LogContext, seen: WeakSet<object>): LogContext {
  const result: LogContext = {};

  for (const [key, value] of Object.entries(context)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(value, seen);
  }

  return result;
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
 *    terceiro chega aqui. Vale para `message` e `stack` de qualquer `Error`
 *    encontrado no contexto e para o próprio `message` da linha (D-779).
 *
 * Arrays também descem agora — antes uma lista de strings passava intacta.
 */
export function redact(context: LogContext): LogContext {
  const seen = new WeakSet<object>();
  seen.add(context);

  return redactObject(context, seen);
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function createLogger(base: LogContext = {}, options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? ((): Date => new Date());

  function write(severity: LogSeverity, message: string, context: LogContext = {}): void {
    const combined: LogContext = { ...base, ...context };
    const merged = redact(combined);

    sink(
      JSON.stringify({
        severity,
        message: redactSecretText(message, REDACTED),
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
