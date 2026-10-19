/**
 * Minimal structured JSON logger (one JSON object per line).
 * Bindings follow the PRD's logging requirements: requestId, eventId,
 * attempt, workerId, outcome are all loggable via child bindings.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type Bindings = Record<string, unknown>;

export interface Logger {
  debug(msg: string, bindings?: Bindings): void;
  info(msg: string, bindings?: Bindings): void;
  warn(msg: string, bindings?: Bindings): void;
  error(msg: string, bindings?: Bindings): void;
  child(bindings: Bindings): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  base?: Bindings;
  /** Sink for emitted lines; defaults to stdout/stderr. Injectable for tests. */
  sink?: (line: string, level: LogLevel) => void;
}

function defaultSink(line: string, level: LogLevel): void {
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const { level, sink = defaultSink } = options;
  let base: Bindings = { ...options.base };

  const emit = (lvl: LogLevel, msg: string, bindings?: Bindings): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...base,
      ...(bindings ?? {}),
    };
    // Avoid '[object Object]' in the rare case of error instances in bindings.
    sink(JSON.stringify(record, jsonReplacer), lvl);
  };

  const logger: Logger = {
    debug: (msg, b) => emit('debug', msg, b),
    info: (msg, b) => emit('info', msg, b),
    warn: (msg, b) => emit('warn', msg, b),
    error: (msg, b) => emit('error', msg, b),
    child: (bindings) =>
      createLogger({
        level,
        sink,
        base: { ...base, ...bindings },
      }),
  };
  return logger;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** Quiet logger for tests. */
export function createSilentLogger(): Logger {
  return createLogger({ level: 'error', sink: () => {} });
}
