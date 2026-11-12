/**
 * More of a data source, added to what a page holds of it.
 *
 * A machine's request can name a data source the section reads (`requests: { more: { source:
 * "photos" } }`): the host runs the source again with the request's input (the next page) and adds
 * the answer here, the same way in every host, so the nodes reading it draw the whole of it.
 *
 *   list    appended: the next page's items after the ones held
 *   object  each key added the same way, so `photos.galleries` grows and `photos.next` moves on
 *   other   the answer's: a page number, a "has more" flag, a total
 *
 * A key the answer leaves out keeps what is held; one it answers `null` is `null` (no next page).
 *
 * PURE.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function addToSource(held: unknown, answer: unknown): unknown {
  if (Array.isArray(held) && Array.isArray(answer)) return [...held, ...answer];
  if (isObject(held) && isObject(answer)) {
    const out: Record<string, unknown> = { ...held };
    for (const [key, value] of Object.entries(answer)) {
      out[key] = key in held ? addToSource(held[key], value) : value;
    }
    return out;
  }
  return answer === undefined ? held : answer;
}
