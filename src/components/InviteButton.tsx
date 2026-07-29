'use client';

import { useState } from 'react';

export function InviteButton({ gameId }: { gameId: string }) {
  const [copied, setCopied] = useState(false);

  const invite = async () => {
    const url = `${window.location.origin}/game/${gameId}`;
    // Native share sheet on phones (SMS, WhatsApp, etc.); clipboard elsewhere.
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Poker night!',
          text: 'Join my poker table:',
          url,
        });
        return;
      } catch {
        // user dismissed the sheet — fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt('Copy this link:', url);
    }
  };

  return (
    <button
      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white active:scale-95"
      onClick={invite}
    >
      {copied ? '✓ Link copied' : '📤 Invite'}
    </button>
  );
}
