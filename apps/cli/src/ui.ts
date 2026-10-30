import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiline,
  multiselect,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";
import type { Terminal } from "./session.ts";

/**
 * The interactive surface. @clack/prompts draws the menus — the same prompts Astro and
 * create-next-app use. Streamed model text stays on the raw terminal, because a full-screen
 * renderer such as Ink would own the frame the tokens are writing into.
 * Picocolors paints help and lists, and turns itself off when the output is not a terminal.
 */

/** One row in a select or multiselect. */
export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

export interface TextPrompt {
  placeholder?: string;
  initial?: string;
  validate?: (value: string | undefined) => string | undefined;
}

/** The questions the wizard asks. Tests pass a scripted one; a terminal gets clack. */
export interface Prompter {
  select(message: string, options: readonly Choice[]): Promise<string>;
  multiselect(message: string, options: readonly Choice[], required?: boolean): Promise<string[]>;
  text(message: string, opts?: TextPrompt): Promise<string>;
  multiline(message: string, opts?: TextPrompt): Promise<string>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
}

/** True while a clack prompt owns Ctrl-C, so the follow-loop handler leaves it alone. */
export interface PromptGate {
  prompting: boolean;
}

/** The person cancelled a prompt. The run, if one was queued, keeps going. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/** A terminal is attached and this is not CI, so prompts can take the screen. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.CI !== "true");
}

export function openSession(title: string): void {
  intro(title);
}

export function closeSession(message: string): void {
  outro(message);
}

export function say(message: string): void {
  log.message(message);
}

export function cancelSession(message: string): never {
  cancel(message);
  throw new Cancelled();
}

export function clackPrompter(gate: PromptGate, onCancel: () => never): Prompter {
  return {
    select: (message, options) =>
      asked(gate, select({ message, options: toOptions(options) }), onCancel),
    multiselect: (message, options, required) =>
      asked(
        gate,
        multiselect({ message, options: toOptions(options), required: required ?? false }),
        onCancel,
      ),
    text: (message, opts) => asked(gate, text(textOptions(message, opts)), onCancel),
    multiline: (message, opts) => asked(gate, multiline(textOptions(message, opts)), onCancel),
    confirm: (message, initial) =>
      asked(gate, confirm({ message, initialValue: initial ?? false }), onCancel),
  };
}

/** The terminal a session writes to. Prompts go through clack when someone is at the keyboard. */
export function createTerminal(opts: {
  interactive: boolean;
  lines?: AsyncIterator<string>;
  gate: PromptGate;
  onCancel: () => never;
}): Terminal {
  if (!opts.interactive) {
    return {
      write: (value) => void process.stdout.write(value),
      line: (value) => console.log(value),
      async ask(prompt) {
        process.stdout.write(prompt);
        const next = await opts.lines?.next();
        if (!next || next.done) {
          process.stdout.write("\n");
          return "";
        }
        return String(next.value).trim();
      },
    };
  }
  return {
    write: (value) => void process.stdout.write(value),
    line: (value) => console.log(value),
    panel(value) {
      const [first, ...rest] = value.split("\n");
      const title = (first ?? "").replace(/^[─\s]+|[─\s]+$/g, "").trim() || "Review";
      const body = rest.join("\n").replace(/^\n+|\n+$/g, "");
      note(body || first, title);
    },
    async ask(prompt) {
      const value = await asked(
        opts.gate,
        text({ message: prompt.replace(/\s+/g, " ").trim() }),
        opts.onCancel,
      );
      return value.trim();
    },
    async choose(message, options) {
      return asked(opts.gate, select({ message, options: toOptions(options) }), opts.onCancel);
    },
  };
}

async function asked<T>(
  gate: PromptGate,
  pending: Promise<T>,
  onCancel: () => never,
): Promise<Exclude<T, symbol>> {
  gate.prompting = true;
  try {
    const value = await pending;
    if (isCancel(value)) return onCancel();
    return value as Exclude<T, symbol>;
  } finally {
    gate.prompting = false;
  }
}

function toOptions(options: readonly Choice[]) {
  return options.map((option) =>
    option.hint
      ? { value: option.value, label: option.label, hint: option.hint }
      : { value: option.value, label: option.label },
  );
}

function textOptions(message: string, opts?: TextPrompt): Parameters<typeof text>[0] {
  const options: Parameters<typeof text>[0] = { message };
  if (opts?.placeholder) options.placeholder = opts.placeholder;
  if (opts?.initial) options.initialValue = opts.initial;
  if (opts?.validate) options.validate = opts.validate;
  return options;
}
