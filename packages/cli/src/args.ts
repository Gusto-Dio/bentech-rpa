export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

/**
 * Hand-rolled instead of pulling in a CLI framework. The surface is six
 * commands, and a dependency-free CLI is one less thing that can differ between
 * a developer's machine and the runtime image.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;

    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }

    const name = token.replace(/^--?/, '');
    const eq = name.indexOf('=');
    if (eq !== -1) {
      flags.set(name.slice(0, eq), name.slice(eq + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }

  return { positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

export function flagInt(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/** APP_ENV is the single switch that makes one image behave correctly everywhere. */
export function resolveEnv(args: ParsedArgs): string {
  return flagString(args, 'env') ?? process.env['APP_ENV'] ?? 'dev';
}
