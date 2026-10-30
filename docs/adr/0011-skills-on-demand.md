# 0011 — Skills loaded on demand

Date: 2026-10-30 · Status: accepted

## Context

Every skill in `spec.skills` went into the instructions in full on every run. Some agents will have several skills where only some apply to a run, such as the Figma-to-DSL agent with one skill per kind of section, and they would spend their memory budget on skills they don't use.

How others do it (checked 2026-10-30):

- **Anthropic Agent Skills**:
  - Each skill's name and description are in the prompt, about 100 tokens a skill. The body is read when the task needs it, and bundled files after that.
  - In Claude Code, a `Skill` tool returns the body as a message that stays in the conversation, and a subagent's `skills:` list preloads skills in full.
  - Names are up to 64 characters and descriptions up to 1,024.
  - <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>, <https://code.claude.com/docs/en/skills>, <https://code.claude.com/docs/en/sub-agents>
- **LangChain deepagents**: names and descriptions are in the system prompt, and the agent reads the body with `read_file`. `pinnedSkills` preloads. <https://docs.langchain.com/oss/javascript/deepagents/skills>
- **Mastra**: names and descriptions are in the system message, and a `skill` tool returns the body as a tool result. <https://mastra.ai/docs/workspace/skills>
- **OpenAI Agents SDK**: an "Available skills" list is in the instructions. The model reads the files in its sandbox, or a `load_skill` tool copies them there first. <https://openai.github.io/openai-agents-js/guides/tools/>

What they share: a short listing is always in the prompt, the model decides when to load a body, and preloading is a separate, explicit list.

## Decision

- **Two lists in the spec.**
  - `skills` go into the instructions in full, as before. They hold the procedure every run needs.
  - `onDemandSkills` are listed by name and description under "Skills you can load", and the agent calls `skill.load` with a name to get one. An on-demand skill's file starts with frontmatter that has a `description:` line.
  - A spec with `onDemandSkills` must list `skill.load` in its tools, and a skill can't be in both lists. `defineAgent` checks both.
- **A dedicated tool, not a file read.** Tools here are typed and there is no generic file access, so reading the file the way Anthropic and deepagents do doesn't fit.
  - `skill.load` returns the skill as its tool result. The result stays in the transcript, including in a resumed run.
  - The tool is `alwaysInline`: its output is never swapped for a reference, as long outputs over `maxInlineChars` are.
- **Limits.** Names are up to 64 characters and descriptions up to 1,024, as in the Agent Skills spec (agentskills.io). Like preloaded skills, the listing must fit the memory budget whole and is never cut.
- **Skills stay files in the agent, the same for every tenant.** We considered tenants' own procedures, stored as procedural rows in `memory_items` and either extending an agent's skill or adding one. We dropped the idea because no tenant needs one: what differs by tenant is house facts (ADR 0010).

## Consequences

- Today's two agents are unchanged: each preloads its one skill, and neither lists `skill.load`.
- Loading costs a step, and a model can fail to load a skill it needed. That is why procedure every run needs stays preloaded. Evals can see which skills a run loaded from its `skill.load` tool events.
- A skill is one markdown body. Bundled files such as scripts and references are not supported yet.
