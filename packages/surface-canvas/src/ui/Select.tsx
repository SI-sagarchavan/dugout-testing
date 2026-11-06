/**
 * Select: the panel's dropdown, in place of the system one.
 *
 * A trigger button and a listbox in the same card style as the account menu. The
 * list is `position: fixed` from the trigger's rect, because cards clip their
 * overflow and an absolutely placed list would be cut off inside one. It opens
 * upward when there is no room below.
 *
 * Keyboard: Enter, Space or the arrows open it; arrows, Home and End move; Enter
 * picks; Escape closes and gives focus back; typing a letter jumps to the next
 * option that starts with it.
 */
import type { CSSProperties, JSX, KeyboardEvent } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon } from "./icons.js";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A second line under the label, muted. */
  hint?: string;
}

const MENU_MAX = 240;
const GAP = 4;

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = "Choose…",
  disabled,
  title,
  width,
}: {
  value: T | null;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  /** The accessible name, since the trigger shows the value and not what it is for. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  /** Width of the trigger in px; the list matches it, or is wider if it must be. */
  width?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selected = options.findIndex((o) => o.value === value);

  const openList = (): void => {
    if (disabled || options.length === 0) return;
    setActive(selected >= 0 ? selected : 0);
    setOpen(true);
  };
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (index: number): void => {
    const option = options[index];
    if (!option) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  // Placed after layout so the first paint is already in the right spot.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const height = Math.min(MENU_MAX, options.length * 32 + 8);
    const below = window.innerHeight - rect.bottom - GAP;
    const up = below < height && rect.top > below;
    setPlace({
      left: rect.left,
      minWidth: rect.width,
      maxWidth: Math.max(rect.width, window.innerWidth - rect.left - 8),
      maxHeight: Math.min(MENU_MAX, Math.max(96, (up ? rect.top : below) - GAP)),
      ...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
    });
  }, [open, options.length]);

  // Keep the active option in view and focus on the list, so arrows work at once.
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onListKey = (event: KeyboardEvent): void => {
    const last = options.length - 1;
    switch (event.key) {
      case "ArrowDown":
        setActive((i) => Math.min(last, i + 1));
        break;
      case "ArrowUp":
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        setActive(0);
        break;
      case "End":
        setActive(last);
        break;
      case "Enter":
      case " ":
        pick(active);
        break;
      case "Escape":
        close(true);
        break;
      case "Tab":
        close(false);
        return;
      default: {
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey) return;
        const letter = event.key.toLowerCase();
        const from = [...options.keys()].filter((i) => i > active).concat([...options.keys()]);
        const next = from.find((i) => options[i]?.label.toLowerCase().startsWith(letter));
        if (next !== undefined) setActive(next);
        return;
      }
    }
    event.preventDefault();
  };

  const current = selected >= 0 ? options[selected] : undefined;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="fs-select"
        style={width ? { width } : undefined}
        disabled={disabled}
        title={title}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            openList();
          }
        }}
      >
        <span className={current ? "truncate" : "truncate is-placeholder"}>
          {current ? current.label : placeholder}
        </span>
        <svg className="fs-select-caret" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <>
          <div className="fs-pop-scrim" onClick={() => close(false)} aria-hidden="true" />
          <ul
            ref={list}
            id={listId}
            className="fs-select-list"
            role="listbox"
            aria-label={label}
            aria-activedescendant={`${listId}-${active}`}
            tabIndex={-1}
            style={place}
            onKeyDown={onListKey}
          >
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={index === active ? "fs-select-opt is-active" : "fs-select-opt"}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(index)}
              >
                <span className="fs-select-tick" aria-hidden="true">
                  {option.value === value ? <CheckIcon size={12} /> : null}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="truncate" style={{ display: "block" }}>
                    {option.label}
                  </span>
                  {option.hint ? (
                    <span className="t-caption truncate" style={{ display: "block", color: "var(--ink-muted)" }}>
                      {option.hint}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
