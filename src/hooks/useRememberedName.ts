'use client';

import { useState, useSyncExternalStore } from 'react';

const KEY = 'hg:playerName';

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

function readStored(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return ''; // storage unavailable (private mode) — start blank
  }
}

/**
 * Name-field state that survives across games: the last name used to create
 * or join a game prefills the next one. useSyncExternalStore keeps hydration
 * clean (the server snapshot is blank; the saved name appears right after);
 * edits write through to localStorage and win over the stored value.
 */
export function useRememberedName(): [string, (name: string) => void] {
  const stored = useSyncExternalStore(subscribe, readStored, () => '');
  const [edited, setEdited] = useState<string | null>(null);

  const update = (next: string) => {
    setEdited(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage unavailable — still usable this session
    }
  };

  return [edited ?? stored, update];
}
