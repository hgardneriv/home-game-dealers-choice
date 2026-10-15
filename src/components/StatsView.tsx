import Link from 'next/link';
import type { StatsSnapshot } from '@/server/stats';
import { GUTS_KINDS, STANDARD_KINDS } from '@/server/stats';

const VARIANT_LABELS: Record<string, string> = {
  holdem: "Texas Hold'em",
  'five-draw': 'Five-card draw',
  'seven-stud': 'Seven-card stud',
  guts: 'Three-card guts',
  baseball: 'Baseball',
  'in-between': 'In-between',
};

const KIND_LABELS: Record<string, string> = {
  highCard: 'High card',
  pair: 'Pair',
  twoPair: 'Two pair',
  trips: 'Three of a kind',
  straight: 'Straight',
  flush: 'Flush',
  fullHouse: 'Full house',
  quads: 'Four of a kind',
  straightFlush: 'Straight flush',
};

const MADE_GAMES = [
  { id: 'holdem', label: "Texas Hold'em", kinds: STANDARD_KINDS },
  { id: 'seven-stud', label: 'Seven-card stud', kinds: STANDARD_KINDS },
  { id: 'five-draw', label: 'Five-card draw', kinds: STANDARD_KINDS },
  { id: 'guts', label: 'Three-card guts', kinds: GUTS_KINDS },
] as const;

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function labelVariant(id: string): string {
  return VARIANT_LABELS[id] ?? id;
}

export function StatsView({ snapshot }: { snapshot: StatsSnapshot }) {
  const { house, players, bots } = snapshot;
  const variantRows = Object.entries(house.variants).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const charts = MADE_GAMES.filter((game) =>
    game.kinds.some((kind) => (house.made[game.id]?.[kind] ?? 0) > 0)
  );

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-8 p-6">
      <div>
        <p className="text-xs opacity-50">
          <Link href="/" className="underline">
            Poker Party
          </Link>
        </p>
        <h1 className="mt-2 text-3xl font-bold">House stats</h1>
        <p className="mt-2 text-sm opacity-70">
          All tables, all time. Play money only — chips have no cash value.
        </p>
        <p className="mt-2 text-sm opacity-70">
          Players are grouped by the same display name, trimmed to 20 characters. Two
          friends who pick the same display name share one row.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Hands</h2>
        {house.handsPlayed === 0 ? (
          <p className="text-sm opacity-60">No hands yet.</p>
        ) : (
          <>
            <p className="text-3xl font-semibold tabular-nums">{fmt(house.handsPlayed)}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase opacity-60">
                  <tr>
                    <th className="py-2 text-left font-medium">Game</th>
                    <th className="py-2 text-right font-medium">Hands</th>
                  </tr>
                </thead>
                <tbody>
                  {variantRows.map(([id, n]) => (
                    <tr key={id} className="border-t border-current/10">
                      <td className="py-1.5">{labelVariant(id)}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmt(n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Made hands</h2>
        <p className="text-sm opacity-70">
          Counted only for games scored by a standard evaluator, labeled by game.
          Baseball (wild 3s and 9s) and in-between are hands and results, not pair or
          flush counts.
        </p>
        {charts.length === 0 ? (
          <p className="text-sm opacity-60">No made-hand counts yet.</p>
        ) : (
          charts.map((game) => (
            <div key={game.id} className="space-y-2">
              <h3 className="text-sm font-semibold">{game.label}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase opacity-60">
                    <tr>
                      <th className="py-2 text-left font-medium">Hand</th>
                      <th className="py-2 text-right font-medium">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {game.kinds.map((kind) => (
                      <tr key={kind} className="border-t border-current/10">
                        <td className="py-1.5">{KIND_LABELS[kind]}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {fmt(house.made[game.id]?.[kind] ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Players</h2>
        {players.length === 0 ? (
          <p className="text-sm opacity-60">No players yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase opacity-60">
                <tr>
                  <th className="py-2 text-left font-medium">Name</th>
                  <th className="py-2 text-right font-medium">Hands</th>
                  <th className="py-2 text-right font-medium">Wins</th>
                  <th className="py-2 text-right font-medium">Calls</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.id} className="border-t border-current/10">
                    <td className="max-w-[10rem] truncate py-1.5">{p.name}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(p.hands)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(p.wins)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(p.calls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Bots</h2>
        {bots.length === 0 ? (
          <p className="text-sm opacity-60">No bot results yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase opacity-60">
                <tr>
                  <th className="py-2 text-left font-medium">Name</th>
                  <th className="py-2 text-right font-medium">Hands</th>
                  <th className="py-2 text-right font-medium">Hand wins</th>
                  <th className="py-2 text-right font-medium">Game wins</th>
                  <th className="py-2 text-right font-medium">Calls</th>
                </tr>
              </thead>
              <tbody>
                {bots.map((b) => (
                  <tr key={b.slug} className="border-t border-current/10">
                    <td className="py-1.5">{b.name}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(b.hands)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(b.wins)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(b.gameWins)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(b.calls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-xs opacity-50">
        <Link href="/privacy" className="underline">
          Privacy
        </Link>
      </p>
    </main>
  );
}
