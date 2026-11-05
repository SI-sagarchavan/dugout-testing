/**
 * The panel's icons, as drawn on the design boards: 24px grid, 1.8 stroke, no fill.
 *
 * Inline rather than a font or an image: the UI is one self-contained file, and a
 * stroke that takes `currentColor` follows the text it sits beside in both themes.
 * Decorative by default (`aria-hidden`); a button that is only an icon carries its
 * own `aria-label`.
 */
import type { JSX } from "react";

function Icon({
  children,
  size,
}: {
  children: JSX.Element | JSX.Element[];
  size?: number;
}): JSX.Element {
  return (
    <svg
      className="ic"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={size ? { width: size, height: size } : undefined}
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

export const RescanIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Icon>
);

export const SendIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <path d="M12 16V5M7 9.5 12 5l5 4.5" />
    <path d="M5 19h14" />
  </Icon>
);

export const ImageIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 17 5-4.5 4 3.5 2.5-2L20 17" />
  </Icon>
);

export const SpacingIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <path d="M4 5v14M20 5v14M8 12h8M8 12l2.5-2.5M8 12l2.5 2.5M16 12l-2.5-2.5M16 12l-2.5 2.5" />
  </Icon>
);

export const TargetIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="7" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
  </Icon>
);

export const CheckIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const AlertIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V13" />
    <path d="M12 16.5v.01" />
  </Icon>
);

export const ArrowUpIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
);

export const UndoIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
  </Icon>
);

export const ChevronIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const RetryIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <path d="M4 4v6h6" />
    <path d="M4.5 14a8 8 0 1 0 2-8.3L4 10" />
  </Icon>
);

export const ArchiveIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <rect x="3.5" y="4" width="17" height="4.5" rx="1.5" />
    <path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5" />
    <path d="M10 13h4" />
  </Icon>
);

export const ExternalIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Icon>
);

export const HeatmapIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Icon>
);

export const CollapseIcon = ({ size }: IconProps): JSX.Element => (
  <Icon size={size}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
