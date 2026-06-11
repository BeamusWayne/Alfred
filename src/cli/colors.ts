/**
 * Terminal color helpers shared by every CLI surface.
 *
 * Color is enabled only when the target stream is a TTY and `NO_COLOR` is
 * unset (https://no-color.org). Every helper degrades to the identity
 * function, so callers never branch.
 */

export interface Palette {
  readonly dim: (s: string) => string;
  readonly red: (s: string) => string;
  readonly green: (s: string) => string;
  readonly yellow: (s: string) => string;
  readonly bold: (s: string) => string;
}

const CODES = {
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  bold: 1,
} as const;

/** True when ANSI color should be emitted on `stream`. */
export function colorEnabled(stream: { isTTY?: boolean | undefined }): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  return Boolean(stream.isTTY);
}

/** Build a palette for `stream`; plain identity functions when color is off. */
export function palette(stream: { isTTY?: boolean | undefined }): Palette {
  const on = colorEnabled(stream);
  const wrap = (code: number) =>
    on ? (s: string) => `\x1b[${code}m${s}\x1b[0m` : (s: string) => s;
  return {
    dim: wrap(CODES.dim),
    red: wrap(CODES.red),
    green: wrap(CODES.green),
    yellow: wrap(CODES.yellow),
    bold: wrap(CODES.bold),
  };
}
