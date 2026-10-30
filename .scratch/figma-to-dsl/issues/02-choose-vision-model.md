# 02 · Choose the vision model

Status: ready-for-human
Type: decision

## What

The repair agent has to look at screenshots, renders and diffs. DeepSeek, our model today, can't read images. Choose a model that can and is reachable through our OpenAI-compatible client (ADR 0001):

- Gemini, through its OpenAI-compatible endpoint. The AI gateway already uses it, and the key already sits in Secrets Manager.
- Claude or GPT, if Gemini's quality or limits fall short.

Things to check on a few real sections: how well it locates layout faults from a crop and a diff, whether it follows tool schemas, image size limits, price per image, and whether it supports strict tool schemas.

## Why

Harness ticket 03 (model per agent) needs a concrete model to configure, and ticket 11 can't run without one.

## Done when

- A model is chosen, with its endpoint, key location and pricing written down.
- A quick comparison on 3–5 sections from the corpus (ticket 03) backs the choice.

## Pointers

- `packages/core/src/model/config.ts` (tiers, pricing), `.env.example`
- AI gateway: `wnm-fanxp-lambdas` branch `docs/ai-gateway-prod-handoff`, `lambdas/ai-gateway/DEVOPS.md` (Gemini through `GEMINI_BASE_URL`)
