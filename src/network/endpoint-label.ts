/** A log label for a configured endpoint. Paths, queries and user-info may contain credentials. */
export function endpointLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[invalid endpoint]";
  }
}
