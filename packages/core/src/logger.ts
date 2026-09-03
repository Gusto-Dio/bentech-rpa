import { pino, stdSerializers, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/**
 * Paths scrubbed from every log line. Automations run against payroll, benefits
 * and carrier systems, so the default posture is that anything resembling a
 * credential or a person's identifiers never reaches the log pipeline.
 *
 * Wildcards match one level, so `*.ssn` covers `payload.ssn` and `member.ssn`
 * but not `payload.member.ssn` - add explicit paths for deeper nesting.
 */
export const REDACT_PATHS: readonly string[] = [
  'password',
  '*.password',
  'passwd',
  '*.passwd',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'ssn',
  '*.ssn',
  'ein',
  '*.ein',
  'taxId',
  '*.taxId',
  'dob',
  '*.dob',
  'dateOfBirth',
  '*.dateOfBirth',
  'accountNumber',
  '*.accountNumber',
  'routingNumber',
  '*.routingNumber',
  'payload.member.ssn',
  'payload.member.dateOfBirth',
];

export interface CreateLoggerOptions {
  level: string;
  /** Human-readable output via pino-pretty. Developer machines only. */
  pretty: boolean;
  /** Fields attached to every line, e.g. { runId, automationId }. */
  base: Record<string, unknown>;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const base: LoggerOptions = {
    level: options.level,
    base: options.base,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      err: stdSerializers.err,
      error: stdSerializers.err,
    },
  };

  if (!options.pretty) return pino(base);

  return pino({
    ...base,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '{msg}',
      },
    },
  });
}
