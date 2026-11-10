// pnpm eval data [--live] [--scripted] [--model <name>] [--only id,id]
// The data side of a Handoff: data-bind (and, with --live, hook-maker and Cast) on the cases in
// agents/data-bind/evals/cases.ts, graded by code (packages/evals/src/data.ts). Without --live a
// case reuses the hook output its first live run cached in evals/data/, since Cast allows 25 live
// runs an hour. It is the suite runner of `pnpm eval <agent>`, pointed at data-bind.
process.argv.splice(2, 0, "data-bind");
await import("../../../packages/evals/scripts/eval.ts");

export {};
