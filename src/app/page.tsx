import { CreateGame } from '@/components/CreateGame';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold">Home Game — Dealer&apos;s Choice</h1>
        <p className="mt-2 text-sm opacity-70">
          Poker night with friends — share a link, take a seat, and the dealer calls
          the game.
        </p>
      </div>
      <CreateGame />
    </main>
  );
}
