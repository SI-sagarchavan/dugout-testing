import { createScriptedModel } from "@dugout/core";
import { describe, expect, it } from "vitest";
import { createModelJudge } from "../src/index.ts";

describe("model judge", () => {
  it("reads the verdict from a reply that wraps it in a code fence", async () => {
    const client = createScriptedModel([
      { content: 'Here is my verdict:\n```json\n{"score": 4, "reasons": ["minor tone"]}\n```' },
    ]);
    const verdict = await createModelJudge(client, "m", "Grade it.")("copy");
    expect(verdict).toEqual({ score: 4, reasons: ["minor tone"], servedModel: "m" });
  });

  it("asks again once, then fails, when the reply has no valid verdict", async () => {
    const client = createScriptedModel([{ content: "Looks good!" }, { content: '{"score": 9}' }]);
    await expect(createModelJudge(client, "m", "Grade it.")("copy")).rejects.toThrow(
      "judge returned invalid json",
    );
    expect(client.requests).toHaveLength(2);
  });
});
