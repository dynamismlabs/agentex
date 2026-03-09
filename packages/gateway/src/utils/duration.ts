const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a duration string like "24h", "30m", "7d", "120s" into milliseconds.
 *
 * Format: `<number><unit>` where unit is s (seconds), m (minutes), h (hours), d (days).
 */
export function parseDuration(str: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(str.trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${str}". Expected format: <number><unit> where unit is s, m, h, or d`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = UNITS[unit];
  if (multiplier === undefined) {
    throw new Error(`Unknown duration unit "${unit}"`);
  }
  return value * multiplier;
}
