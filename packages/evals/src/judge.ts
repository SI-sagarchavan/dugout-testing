import type { ModelClient } from "@dugout/contracts";
import { z } from "zod";

export const JudgeVerdict = z.object({
  score: z.number().int().min(1).max(5),
  reasons: z.array(z.string()).min(1).max(5),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict> & { servedModel: string };

/** Grades `content` against the rubric in `system`, which asks for the verdict as json. */
export type ModelJudge = (content: string) => Promise<JudgeVerdict>;

/**
 * A model judge: `system` holds the rubric and the 1 to 5 scale; each call grades one piece of
 * content. Its score is reported but does not gate (ADR 0001): the judge is the same vendor as the
 * writer, and its model isn't version-pinned.
 */
export function createModelJudge(client: ModelClient, model: string, system: string): ModelJudge {
  return async (content) => {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const turn = await client.complete({
        model,
        tools: [],
        extraBody: { response_format: { type: "json_object" } },
        messages: [
          { role: "system", content: system },
          { role: "user", content },
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

export type Judge = (input: {
  rubric: string;
  styleGuide: string;
  text: string;
}) => Promise<JudgeVerdict>;

const SYSTEM = `You grade sports copy against a publisher's house style. Reply in json only:
{"score": <integer 1-5>, "reasons": ["<short reason>", ...]}

Scale:
5 = fully on-style; an editor would publish it unchanged
4 = minor tone issues
3 = noticeably off-style in places
2 = mostly off-style
1 = ignores the house style

Judge tone and voice only. Do not judge factual accuracy, length or spelling; other checks cover those.`;

/** The sports-copy judge: grades tone against the house style. */
export function createJudge(client: ModelClient, model: string): Judge {
  const judge = createModelJudge(client, model, SYSTEM);
  return ({ rubric, styleGuide, text }) =>
    judge(`House style:\n${styleGuide}\n\nRubric:\n${rubric}\n\nCopy to grade:\n${text}`);
}
