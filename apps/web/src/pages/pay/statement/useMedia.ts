import { useSyncExternalStore } from 'react';

/** True while a media query matches (re-renders when it changes). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The three-column statement needs this much room; below it, the phone layout. */
export const DESKTOP_QUERY = '(min-width: 1200px)';
