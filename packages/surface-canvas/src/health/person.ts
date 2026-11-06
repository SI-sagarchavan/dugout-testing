/**
 * Who is using the plugin. PURE. No Figma import.
 *
 * The panel names the person on the status line and the account menu. It does
 * not keep a log of who bound what: that used to be written into the designer's
 * file on every bind, and nothing downstream read it.
 */
export interface Person {
  id: string | null;
  name: string;
  color: string;
}

export function firstName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Anonymous";
  return trimmed.split(/\s+/)[0]!;
}

export function initialOf(name: string): string {
  const first = firstName(name);
  return (first[0] ?? "?").toUpperCase();
}
