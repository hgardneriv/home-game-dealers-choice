/**
 * True while a variant's result-reveal window is still open. In-between uses
 * this to hold the next wager until the table has seen the third card.
 * A pass (shows → false) opens no window.
 */
export function revealWindowOpen(
  events: { type: string; at: number; data: unknown }[],
  now: number,
  cfg: { eventType: string; ms: number; shows?: (data: unknown) => boolean } | undefined
): boolean {
  if (!cfg) return false;
  let latestAt: number | null = null;
  for (const e of events) {
    if (e.type === cfg.eventType && (cfg.shows?.(e.data) ?? true)) latestAt = e.at;
  }
  return latestAt !== null && now - latestAt < cfg.ms;
}
