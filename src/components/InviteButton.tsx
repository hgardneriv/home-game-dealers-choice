'use client';

import { useState } from 'react';
import { inviteSharePayload } from '@/hooks/invite';

export function InviteButton({ gameId }: { gameId: string }) {
  const [copied, setCopied] = useState(false);

  const invite = async () => {
    const url = `${window.location.origin}/game/${gameId}`;
    const share = inviteSharePayload(url);
    try {
      // Browser share sheet: title + text, with the table URL on the next
      // line. No separate `url` field — Messages would preview that first
      // and drop the sentence under it. Clipboard fallback stays the bare URL.
      if (navigator.share) {
        try {
          await navigator.share(share);
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
    } catch {
      // keep the tap from becoming an unhandled rejection (Next overlay)
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
