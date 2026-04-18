/**
 * Truncate a string to a maximum length. If the string is longer than
 * `max` characters, the returned value is cut at `max - 1` and an ellipsis
 * character is appended so the total visible length is still at most `max`.
 *
 * Whitespace is preserved, empty strings pass through unchanged, and the
 * function is safe against nullish input.
 */
export function truncateMessage(message: string | undefined | null, max = 80): string {
  if (!message) return '';
  const trimmed = message.split('\n')[0];
  if (trimmed.length <= max) return trimmed;
  if (max <= 1) return '\u2026';
  // Reserve one character for the ellipsis.
  return `${trimmed.slice(0, max - 1).trimEnd()}\u2026`;
}
