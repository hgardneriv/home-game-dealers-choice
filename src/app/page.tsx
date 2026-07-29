import { CreateGame } from '@/components/CreateGame';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold">Home Game Poker</h1>
        <p className="mt-2 text-sm opacity-70">
          Texas Hold&apos;em with friends — share a link, take a seat.
        </p>
      </div>
      <CreateGame />
    </main>
  );
}
