/**
 * Sliding-renewal fetch interceptor.
 *
 * The server's auth middleware sets an `X-New-Token` response header whenever
 * an inbound request's JWT is in its last day of life. We monkey-patch
 * `window.fetch` once at app boot to swap that fresh token into localStorage
 * (and the auth store, if loaded) so the user never sees an unexpected logout
 * during normal active use.
 *
 * Side note: we intentionally don't try to mutate the in-flight `Authorization`
 * header — the current request already authenticated successfully, and the new
 * token only needs to be on disk for the *next* request.
 */

let installed = false;

export function installAuthFetch() {
  if (installed || typeof window === 'undefined' || !window.fetch) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init) {
    const response = await originalFetch(input, init);
    try {
      const fresh = response.headers && response.headers.get && response.headers.get('X-New-Token');
      if (fresh) {
        localStorage.setItem('authToken', fresh);
        // If the auth store has been instantiated, keep its in-memory copy in
        // sync so subsequent requests immediately use the new token.
        try {
          if (window.Pinia && typeof window.Pinia.useAuthStore === 'function') {
            const store = window.Pinia.useAuthStore();
            if (store) store.token = fresh;
          }
        } catch {
          /* store not ready yet — localStorage is enough for next page load */
        }
      }
    } catch {
      /* never let header inspection break a successful response */
    }
    return response;
  };
}
