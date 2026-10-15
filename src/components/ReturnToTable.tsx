'use client';

import Link from 'next/link';
import { useLastGameId } from '@/hooks/lastGame';

/** Web-only resume link. Play Now and the create form stay on the page. */
export function ReturnToTable() {
  const gameId = useLastGameId();
  if (!gameId) return null;
  return (
    <Link
      href={`/game/${gameId}`}
      className="block text-center text-sm font-medium text-emerald-700 underline dark:text-emerald-400"
    >
      Return to table
    </Link>
  );
}
