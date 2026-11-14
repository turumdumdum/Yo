// An invitation link looks like https://app.example/?invite=<token>. The token is kept
// in this browser until the visitor has signed in (and set up two-step verification),
// then exchanged for a membership.

const KEY = 'pending-invitation';

/** Moves the token from the address bar into storage, so it is not left in the URL. */
export function captureInvitationFromUrl(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('invite');
  if (!token) return;
  try {
    localStorage.setItem(KEY, token);
  } catch {
    return; // Storage unavailable: leave the link as it is.
  }
  url.searchParams.delete('invite');
  window.history.replaceState(null, '', url);
}

export function pendingInvitation(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearPendingInvitation(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
