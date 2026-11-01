import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flatTreeSchema } from "@fanos/dsl";
import { type DataBag, Render } from "@fanos/renderer";
import { emitCss, loadSurfaces, loadTheme } from "@fanos/tokens";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function readJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function loadCard() {
  const agentTree = readJson(join(repo, "packages/dsl/fixtures/preview/card.json"));
  const agentData = readJson(join(repo, "packages/renderer/fixtures/preview/card.data.json"));
  const fromAgent = agentTree !== undefined && agentData !== undefined;
  const tree = flatTreeSchema.parse(
    fromAgent ? agentTree : readJson(join(repo, "packages/dsl/fixtures/sample-card.json")),
  );
  const data = (
    fromAgent ? agentData : readJson(join(repo, "packages/renderer/fixtures/sample-card.data.json"))
  ) as DataBag | undefined;
  const { css: themeCss } = emitCss(loadTheme(join(repo, "packages/tokens/fixtures/southern-brave.json")), {
    surfaces: loadSurfaces(join(repo, "packages/tokens/surfaces/southern-brave.json")),
  });
  const structuralCss = readFileSync(join(repo, "packages/renderer/src/styles.css"), "utf8");
  return { tree, data, themeCss, structuralCss, fromAgent };
}

export default function Page() {
  const { tree, data, themeCss, structuralCss, fromAgent } = loadCard();
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        display: "grid",
        placeItems: "center",
        padding: 32,
        color: "#f5f5f5",
        fontFamily: "Montserrat, sans-serif",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: `${themeCss}\n${structuralCss}` }} />
      <div>
        <p
          style={{
            margin: "0 0 16px",
            fontSize: 12,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            opacity: 0.7,
          }}
        >
          {fromAgent ? "Agent card" : "Sample card"} · Southern Brave
        </p>
        <Render tree={tree} data={data} width={1366} />
      </div>
    </main>
  );
}
