import Link from 'next/link';
import { CreateGame } from '@/components/CreateGame';
import { ReturnToTable } from '@/components/ReturnToTable';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold">Poker Party</h1>
        <p className="mt-2 text-sm opacity-70">
          Dealer&apos;s choice with friends — share a link, take a seat, and the dealer
          calls the game.
        </p>
        <p className="mt-1 text-xs opacity-50">Play money only — chips have no cash value.</p>
      </div>
      <ReturnToTable />
      <CreateGame />
      <footer className="text-center text-xs opacity-50">
        <Link href="/stats" className="underline">
          Stats
        </Link>
        {' · '}
        <Link href="/privacy" className="underline">
          Privacy
        </Link>
      </footer>
    </main>
  );
}
