/** Turns anything thrown or returned by Supabase into a sentence for the user. */
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message) {
    // Database messages are lower-case fragments; show them as sentences.
    const text = error.message.charAt(0).toUpperCase() + error.message.slice(1);
    return /[.!?]$/.test(text) ? text : `${text}.`;
  }
  return 'Something went wrong. Please try again.';
}
