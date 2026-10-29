import type { ModelClient } from "@dugout/contracts";
import { JudgeVerdict } from "@dugout/evals";

const SYSTEM = `You grade a website sitemap (pages and a header menu) against the brief it was made from. Reply in json only:
{"score": <integer 1-5>, "reasons": ["<short reason>", ...]}

Scale:
5 = covers what the brief asks for with a sensible structure and menu; an editor would import it unchanged
4 = small gaps or an odd menu choice
3 = misses something the brief asked for, or adds clutter
2 = mostly misses the brief
1 = ignores the brief

Judge fit to the brief and sensible structure only. Do not judge url syntax, limits or menu rules; other checks cover those.`;

export type FitJudge = (input: {
  brief: string;
  houseFacts: string;
  outline: string;
}) => Promise<JudgeVerdict & { servedModel: string }>;

/** The sports-copy judge in `@dugout/evals` grades tone, so this one grades fit to the brief. Reported, never gating. */
export function createFitJudge(client: ModelClient, model: string): FitJudge {
  return async ({ brief, houseFacts, outline }) => {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const turn = await client.complete({
        model,
        tools: [],
        extraBody: { response_format: { type: "json_object" } },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `Brief:\n${brief}\n\nHouse facts:\n${houseFacts}\n\nSitemap:\n${outline}`,
          },
        ],
      });
      try {
        const verdict = JudgeVerdict.parse(JSON.parse(turn.message.content));
        return { ...verdict, servedModel: turn.servedModel };
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    throw new Error(`judge returned invalid json: ${lastError}`);
  };
}
