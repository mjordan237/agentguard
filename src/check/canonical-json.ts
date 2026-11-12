/** JSON with object keys sorted at every level, undefined fields left out, and bigints as decimal strings: the same bytes for the same value. */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (typeof item === "bigint") return item.toString();
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().filter((key) => (item as Record<string, unknown>)[key] !== undefined).map((key) => [key, normalize((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}
