/**
 * lib/models/urls.ts — small URL helpers shared by the adapters, the
 * gateway, the endpoints module and the embeddings provider.
 *
 * WHY: `url.replace(/\/+$/, '')` backtracks quadratically on a long run of
 * slashes followed by another character (CodeQL js/polynomial-redos), and
 * a base URL can come from an environment variable or a caller's option.
 * This scans from the end once.
 */

/** `url` without its trailing slashes, in one pass from the end. */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
}
