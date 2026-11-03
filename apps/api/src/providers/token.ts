/** Tokens are copied from a web page: drop the whitespace, line breaks and quotes that come along. */
export function normaliseToken(raw: string): string {
  return raw.replace(/[\s"'`]/g, '');
}
