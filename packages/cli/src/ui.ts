/** Built with fromCharCode so no literal control byte ever lands in the source. */
const ESC = String.fromCharCode(27);

const useColor =
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb' &&
  process.stdout.isTTY === true;

function wrap(code: string, value: string): string {
  return useColor ? `${ESC}[${code}m${value}${ESC}[0m` : value;
}

export const style = {
  bold: (v: string): string => wrap('1', v),
  dim: (v: string): string => wrap('2', v),
  red: (v: string): string => wrap('31', v),
  green: (v: string): string => wrap('32', v),
  yellow: (v: string): string => wrap('33', v),
  cyan: (v: string): string => wrap('36', v),
};

export function heading(text: string): void {
  process.stdout.write(`\n${style.bold(text)}\n`);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function errorLine(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** Right-pads a column so tables line up without a formatting dependency. */
export function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}
