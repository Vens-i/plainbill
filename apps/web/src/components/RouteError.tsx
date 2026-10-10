/** Shown instead of a crash screen if a page fails to load or render. */
import { useRouteError } from 'react-router';

export function RouteError() {
  const error = useRouteError();
  // A deploy can replace the old code chunks under an open tab; a reload fetches the new ones.
  const stale =
    error instanceof Error && /dynamically imported module|Failed to fetch/i.test(error.message);
  return (
    <main className="route-error" role="alert">
      <h1>{stale ? 'This page was updated' : 'Something went wrong'}</h1>
      <p>
        {stale
          ? 'Reload to get the latest version.'
          : 'Please reload the page. If it keeps happening and you are paying a bill, call the office.'}
      </p>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
        Reload
      </button>
    </main>
  );
}
