import { useEffect, useState } from 'react';

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

/** Show a short confirmation at the bottom of the screen. */
export function toast(message: string): void {
  for (const l of listeners) l(message);
}

export function Toaster() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const show: Listener = (m) => {
      setMessage(m);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMessage(null), 4200);
    };
    listeners.add(show);
    return () => {
      listeners.delete(show);
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {message && <div className="toast">{message}</div>}
    </div>
  );
}
