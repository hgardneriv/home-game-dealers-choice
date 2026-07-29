'use client';

import { useEffect, useState } from 'react';

export type Orientation = 'portrait' | 'landscape';

/** Landscape = wide viewport (desktop or rotated phone); portrait = phone upright. */
export function useOrientation(): Orientation {
  const [orientation, setOrientation] = useState<Orientation>('landscape');
  useEffect(() => {
    const query = window.matchMedia('(orientation: landscape) and (min-width: 700px)');
    const update = () => setOrientation(query.matches ? 'landscape' : 'portrait');
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return orientation;
}
