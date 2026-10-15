import type { Metadata } from 'next';
import { StatsView } from '@/components/StatsView';
import { readStatsSnapshot } from '@/server/stats';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'House stats — Poker Party',
  description: 'All-time hands, made hands by game, and the player board.',
};

export default async function StatsPage() {
  const snapshot = await readStatsSnapshot();
  return <StatsView snapshot={snapshot} />;
}
