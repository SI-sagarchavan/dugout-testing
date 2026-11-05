import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { preparePage, Render } from "@fanos/renderer";
import { PreviewError, readHandoff } from "../../../../lib/control-plane";

/**
 * A Handoff, rendered as a page: `/preview/<project>/<run or dsl_tree id>`.
 *
 * The same tree, theme and surfaces as Studio's static preview, through the same recipe
 * (`preparePage`), so the first paint is the same page the fidelity harness measured. What this
 * adds is the browser: the renderer's client components hydrate here, so a carousel swipes.
 *
 * Query: `?theme=`, `?surfaces=`, `?tree=`, `?data=`, `?plan=` override artifacts; `?width=` the
 * page width; `?bg=` the background (hex, no `#`).
 */

// A tree is immutable but the renderer is not: a rebuilt SDK shows on reload.
export const dynamic = "force-dynamic";

// apps/web is the working directory under `next dev`, `next start` and the Docker image alike.
const repo = join(process.cwd(), "../..");

/**
 * The renderer's base stylesheet, after the theme CSS as in Studio's preview and the harness.
 * `dist/` first: it is what ships. Overlay layering, anchors and the carousel's first paint live
 * there, so a page without it is not the design.
 */
function baseStyles(): string {
  const path = ["packages/renderer/dist/styles.css", "packages/renderer/src/styles.css"]
    .map((p) => join(repo, p))
    .find((p) => existsSync(p));
  if (!path) throw new PreviewError(500, "@fanos/renderer base stylesheet not found — run `pnpm build`");
  return readFileSync(path, "utf8");
}

type Params = Promise<{ project: string; ref: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function PreviewPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { project, ref } = await params;
  const query = await searchParams;
  const one = (name: string) => {
    const v = query[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const width = Number(one("width"));
  const bg = one("bg");
  const background = bg && /^[0-9a-f]{3,8}$/i.test(bg) ? `#${bg}` : "#ffffff";

  try {
    const send = await readHandoff(decodeURIComponent(project), decodeURIComponent(ref), query);
    const page = preparePage({
      tree: send.tree,
      theme: send.theme,
      ...(send.surfaces !== undefined ? { surfaces: send.surfaces } : {}),
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(send.plan ? { plan: send.plan } : {}),
    });
    for (const d of page.binding?.drift ?? []) console.warn(`[preview] plan drift ${d}`);

    return (
      <>
        <style
          // biome-ignore lint/security/noDangerouslySetInnerHtml: CSS emitted by our own token compiler
          dangerouslySetInnerHTML={{
            __html: `${page.css}\n${baseStyles()}\nhtml, body { margin: 0; padding: 0; background: ${background}; }\n${
              page.fluid ? "" : `body { width: ${page.width}px; }`
            }`,
          }}
        />
        <Render
          tree={page.tree}
          assets={page.assets}
          {...(send.data ? { data: send.data } : {})}
          {...(page.fluid ? {} : { width: page.width })}
        />
      </>
    );
  } catch (err) {
    const status = err instanceof PreviewError ? err.status : 422;
    const message = err instanceof Error ? err.message : String(err);
    return (
      <pre
        style={{
          margin: 0,
          padding: 20,
          background: "#faf7ef",
          color: "#9a3b2f",
          font: "12px/1.6 ui-monospace, monospace",
          whiteSpace: "pre-wrap",
        }}
      >
        {status} · {message}
      </pre>
    );
  }
}
