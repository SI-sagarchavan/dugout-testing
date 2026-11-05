/**
 * Any thrown value, as a sentence.
 *
 * Figma's sandbox `fetch` does not always reject with an `Error`: a blocked domain
 * or a failed connection can arrive as a plain object, and `String({})` is
 * "[object Object]", which is what a designer once saw in the account menu in
 * place of the reason. Everything that turns a caught value into text goes
 * through here.
 *
 * PURE.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    for (const key of ["message", "error", "reason", "statusText"]) {
      const value = record[key];
      if (typeof value === "string" && value) return value;
    }
    try {
      const text = JSON.stringify(err);
      if (text && text !== "{}") return text;
    } catch {
      // Circular or otherwise unprintable: fall through.
    }
  }
  return "no reason was given";
}
