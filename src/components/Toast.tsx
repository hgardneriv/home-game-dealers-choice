'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

type ToastKind = 'error' | 'info';

const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: ToastKind }[]>([]);
  const nextId = useRef(1);

  const show = useCallback((message: string, kind: ToastKind = 'error') => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed left-1/2 top-4 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`rounded-lg border bg-zinc-900/95 px-4 py-2 text-sm text-white shadow-xl ${
                t.kind === 'error' ? 'border-red-400/40' : 'border-white/20'
              }`}
            >
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
