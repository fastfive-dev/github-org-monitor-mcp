/**
 * Convert an ISO date string to a Unix timestamp in seconds.
 * Returns fallback (default 0) if the input is undefined.
 *
 * When `endOfDay` is true, adds 86399 seconds (23:59:59) so that a date
 * like "2024-12-31" covers the entire day, not just midnight.
 */
export function toUnixSeconds(
  isoDate: string | undefined,
  fallback: number = 0,
  endOfDay: boolean = false
): number {
  if (!isoDate) return fallback;
  const ts = new Date(isoDate).getTime() / 1000;
  return endOfDay ? ts + 86399 : ts;
}
