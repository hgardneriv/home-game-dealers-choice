import type { GameEvent } from '@/engine/types';

type Pot = { amount: number; winners: string[]; eligible?: string[] };

/**
 * Turn a table event into history lines. Empty means the event is not shown
 * (turn stamps, pause, etc.). Hand results expand into one line per remaining
 * player so a screenshot is a readable paper trail.
 */
export function describeEvent(event: GameEvent, names: (id: string) => string): string[] {
  const d = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'hand-started':
      return [`— Hand #${d.handNo}: ${String(d.variantName ?? '')} —`];
    case 'antes-posted':
      return [`Everyone antes $${d.amount}`];
    case 'pot-matched':
      return [`${names(String(d.playerId))} matches the pot ($${d.amount} to the next hand)`];
    case 'pot-carried':
      return [`$${d.amount} carries to the next pot`];
    case 'cards-drawn':
      return [
        Number(d.count) === 0
          ? `${names(String(d.playerId))} stands pat`
          : `${names(String(d.playerId))} draws ${d.count}`,
      ];
    case 'choosing-game':
      return [`${names(String(d.playerId ?? d.dealerId))} has the deal — picking the game`];
    case 'game-chosen':
      return [
        d.auto
          ? `Time's up — ${String(d.variantName)} continues`
          : `${names(String(d.dealerId))} calls ${String(d.variantName)}`,
      ];
    case 'action': {
      const move = String(d.move);
      const auto = d.auto ? ' (auto)' : '';
      if (move === 'fold' || move === 'check') return [`${names(String(d.playerId))} ${move}s${auto}`];
      if (move === 'call') return [`${names(String(d.playerId))} calls $${d.amount}${auto}`];
      if (move === 'bet' || move === 'raise')
        return [`${names(String(d.playerId))} ${move}s to $${d.amount}`];
      return [];
    }
    case 'street-dealt':
      return [`${String(d.street)}: ${(d.cards as string[]).join(' ')}`];
    case 'stud-street': {
      const ups = Object.entries((d.upCards as Record<string, string>) ?? {});
      if (ups.length === 0) return [`${String(d.street)} street: down cards dealt`];
      return [`${String(d.street)} street: ${ups.map(([id, c]) => `${names(id)} ${c}`).join(', ')}`];
    }
    case 'declared':
      return [`${names(String(d.playerId))} is ${d.choice === 'in' ? 'IN' : 'out'}`];
    case 'flipped':
      return [`${names(String(d.playerId))} flips ${d.card}`];
    case 'busted-out':
      return [`${names(String(d.playerId))} can't beat the board — out`];
    case 'in-between-turn':
      return [`${names(String(d.playerId))} shows ${(d.cards as string[]).join(' ')}`];
    case 'in-between-ace':
      return [`${names(String(d.playerId))} draws an ace — calling it…`];
    case 'in-between-result': {
      const who = names(String(d.playerId));
      const third = String(d.third);
      switch (d.outcome) {
        case 'win':
          return [`${who} hits ${third} — wins $${d.amount}`];
        case 'lose':
          return [`${who} misses (${third}) — pays $${d.amount}`];
        case 'post':
          return [`${who} hits the post (${third}) — pays double, $${d.amount}`];
        default:
          return [`${who} passes`];
      }
    }
    case 'in-between-reshuffle':
      return ['Deck reshuffled'];
    case 'hand-result':
      return describeHandResult(d, names);
    case 'player-seated':
      return [`${String(d.name)} sits down`];
    case 'player-removed':
      return [
        d.status === 'kicked'
          ? `${names(String(d.playerId))} was removed by the host`
          : `${names(String(d.playerId))} left the game`,
      ];
    case 'player-busted':
      return [`${names(String(d.playerId))} is busted`];
    case 'topped-up':
      return [`${names(String(d.playerId))} tops up $${d.amount}`];
    case 'top-up-window':
      return ['Waiting for rebuys…'];
    case 'player-away':
      return [`${names(String(d.playerId))} is away`];
    case 'player-back':
      return [`${names(String(d.playerId))} is back`];
    case 'time-bank':
      return [`${names(String(d.playerId))} uses time bank`];
    case 'game-ended':
      return [d.winnerId ? `🏆 ${names(String(d.winnerId))} wins the game!` : 'Game over'];
    case 'rematch':
      return ['🃏 Same table — new night'];
    default:
      return [];
  }
}

function describeHandResult(d: Record<string, unknown>, names: (id: string) => string): string[] {
  const pots = (d.pots as Pot[] | undefined) ?? [];
  const payouts = d.payouts as Record<string, number> | undefined;
  const refunds = (d.refunds as Record<string, number> | undefined) ?? {};
  const revealed = (d.revealed as Record<string, string[]> | undefined) ?? {};
  const hands = (d.hands as Record<string, string[]> | undefined) ?? revealed;
  const descriptions = (d.descriptions as Record<string, string> | undefined) ?? {};
  const board = (d.board as string[] | undefined) ?? [];
  const kind = d.kind as string | undefined;
  const showdownOrder = (d.showdownOrder as string[] | undefined) ?? [];

  const winners: string[] = [];
  for (const pot of pots) {
    for (const id of pot.winners) {
      if (!winners.includes(id)) winners.push(id);
    }
  }

  const lines: string[] = [];
  for (const id of winners) {
    const amount = winnerShare(id, pots, payouts, refunds);
    const cards = hands[id] ?? revealed[id];
    const desc = descriptions[id];
    let line = `${names(id)} wins $${amount}`;
    if (cards) line += ` with ${cards.join(' ')}`;
    if (desc) line += ` — ${desc}`;
    if (kind === 'foldWin' && !cards) line += ' (uncontested)';
    lines.push(line);
  }

  const rest = uniqueIds([...showdownOrder, ...Object.keys(hands)]).filter(
    (id) => !winners.includes(id) && (hands[id] || revealed[id])
  );
  for (const id of rest) {
    const cards = (hands[id] ?? revealed[id]).join(' ');
    const desc = descriptions[id];
    lines.push(desc ? `${names(id)} had ${cards} — ${desc}` : `${names(id)} had ${cards}`);
  }

  for (const [id, amount] of Object.entries(refunds)) {
    if (amount > 0) lines.push(`$${amount} uncalled returned to ${names(id)}`);
  }

  if (pots.length > 1) {
    lines.push(
      `Pots: ${pots.map((p) => `$${p.amount} → ${p.winners.map(names).join(' & ')}`).join('; ')}`
    );
  }

  if (board.length > 0) lines.push(`Board: ${board.join(' ')}`);
  return lines;
}

function uniqueIds(ids: string[]): string[] {
  const seen: string[] = [];
  for (const id of ids) {
    if (!seen.includes(id)) seen.push(id);
  }
  return seen;
}

/** Pot share credited to a winner — payouts minus any uncalled refund, else odd-chip math. */
function winnerShare(
  id: string,
  pots: Pot[],
  payouts: Record<string, number> | undefined,
  refunds: Record<string, number>
): number {
  if (payouts && payouts[id] !== undefined) return payouts[id] - (refunds[id] ?? 0);
  let total = 0;
  for (const pot of pots) {
    if (!pot.winners.includes(id)) continue;
    const n = pot.winners.length;
    const base = Math.floor(pot.amount / n);
    const rem = pot.amount - base * n;
    total += base + (pot.winners.indexOf(id) < rem ? 1 : 0);
  }
  return total;
}
