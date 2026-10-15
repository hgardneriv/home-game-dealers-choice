import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy — Poker Party',
  description: 'What this play-money table stores.',
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-6 text-sm leading-relaxed">
      <p className="text-xs opacity-50">
        <Link href="/" className="underline">
          Poker Party
        </Link>
      </p>
      <h1 className="text-3xl font-bold">Privacy</h1>
      <p>
        This is a play-money dealer&apos;s choice game. There are no accounts. Chips have
        no cash value.
      </p>
      <p>
        Sitting down sets an httpOnly cookie named <code>hg_</code> plus the table id.
        It only identifies you at that table.
      </p>
      <p>
        This browser remembers your last display name (<code>hg:playerName</code>) and
        the last table you sat (<code>hg:lastGameId</code>) in localStorage so the home
        page can offer a way back. Leaving or opening a missing table clears the saved
        table.
      </p>
      <p>
        House stats keep the display name you type, trimmed to 20 characters, with no
        expiry. The same name adds to one row. Stats are not tied to an account.
      </p>
      <p>Vercel Analytics may collect a page view. That is separate from the table.</p>
      <p>
        <Link href="/stats" className="underline">
          House stats
        </Link>
      </p>
    </main>
  );
}
