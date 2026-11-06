/**
 * Light / dark, top right beside the account.
 *
 * Figma tells the panel its own theme through a class on the root
 * (`figma-light` / `figma-dark`). Until the designer chooses, the panel follows
 * it. Choosing sets the class here and tells the sandbox to keep the choice
 * across sessions (`clientStorage`: the iframe has no storage of its own).
 */
import type { JSX } from "react";
import type { UiTheme } from "../protocol.js";
import { send } from "./main.js";
import type { PanelAction } from "./state.js";

const root = (): HTMLElement => document.documentElement;

/** The theme Figma gave the panel, read from the class it set. */
function figmaTheme(): UiTheme {
  return root().classList.contains("figma-light") ? "light" : "dark";
}

/** Put the chosen theme on the root, replacing whichever Figma set. */
export function applyUiTheme(theme: UiTheme): void {
  root().classList.remove("figma-light", "figma-dark");
  root().classList.add(theme === "light" ? "figma-light" : "figma-dark");
}

export function ThemeToggle({
  theme,
  dispatch,
}: {
  theme: UiTheme | null;
  dispatch: (action: PanelAction) => void;
}): JSX.Element {
  const current = theme ?? figmaTheme();
  const next: UiTheme = current === "dark" ? "light" : "dark";
  const label = next === "light" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      className="fs-iconbtn"
      aria-label={label}
      title={label}
      onClick={() => {
        applyUiTheme(next);
        dispatch({ type: "ui-theme", theme: next });
        send({ type: "set-ui-theme", theme: next });
      }}
    >
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        {current === "dark" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
          </>
        ) : (
          <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
        )}
      </svg>
    </button>
  );
}
