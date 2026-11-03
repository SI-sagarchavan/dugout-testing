/**
 * The platform's carousel config, read into the DSL.
 *
 * The platform (the FanXP CMS) stores a carousel as snake_case JSON: `slides_per_view`,
 * `nav_arrows`, `nav_indicator`, `autoplay_progress`, colours as theme token names. In the DSL a
 * Carousel is behaviour and motion only, and every control is a node of its own (`controlFor`).
 * So this reads the JSON in two parts:
 *
 * - `props`: the Carousel's own props (slides per view, gap, centring, direction, loop, free
 *   mode, autoplay).
 * - `arrows`, `indicator`, `progress`: what the config says of each control: whether it shows,
 *   where it sits, and how it looks in each state, as state looks in tokens. They are applied to
 *   the control nodes (the design's, when it drew them).
 *
 * The config names a look by number (`variant: "1"`) and gives no sizes or surfaces, so it cannot
 * draw a control the design did not; it says so in `warnings`. Pure: no theme here. Pass the
 * theme's colour names, and a colour the theme does not have is reported, not guessed.
 */

/** As the platform stores it. Every field is optional: a partial config reads as far as it goes. */
export interface PlatformCarousel {
  icon?: string;
  loop?: boolean;
  variant?: string;
  autoplay?: boolean;
  direction?: "horizontal" | "vertical";
  free_mode?: boolean;
  nav_arrows?: {
    variant?: string;
    position?: string;
    visibility?: boolean;
    sub_variant?: string;
    enabled_color?: { text_color?: string; background_color?: string };
    disabled_color?: { text_color?: string; background_color?: string };
  };
  nav_indicator?: {
    type?: string;
    stack?: string;
    offset?: number;
    variant?: string;
    position?: string;
    visibility?: boolean;
    sub_variant?: string;
    enabled_color?: string;
    enabled_width?: number;
    disabled_color?: string;
  };
  space_between?: number;
  centered_slides?: boolean;
  slides_per_view?: number | "auto";
  autoplay_interval?: number;
  autoplay_progress?: { type?: string; color?: string; visibility?: boolean };
}

export interface PlatformReadOptions {
  /** The theme's colour names (`core_neu_700`, …). Given, a name not among them is a warning. */
  colors?: ReadonlySet<string>;
}

/** A look in one state, in colour tokens: the glyph or text (`tone`) and the background (`fill`). */
export interface StateLook {
  tone?: string;
  fill?: string;
}

export interface PlatformArrows {
  visible: boolean;
  /** `center`: one at each inline edge of the carousel, centred on it; `top` / `bottom` likewise. */
  position?: "center" | "top" | "bottom";
  /** The platform's sub-variant, as given (`nearby`). */
  subVariant?: string;
  enabled?: StateLook;
  disabled?: StateLook;
  /** The glyph's icon name, for arrows drawn from a variant. */
  icon?: string;
  variant?: string;
}

export interface PlatformIndicator {
  visible: boolean;
  kind: "pagination" | "counter" | "progress";
  position?: "top" | "bottom";
  /** px from that edge; negative is over the slides. */
  offset?: number;
  stack?: "horizontal" | "vertical";
  shape?: "rounded" | "square";
  /** px width of the current page's dot. */
  activeWidth?: number;
  active?: StateLook;
  inactive?: StateLook;
  variant?: string;
}

export interface PlatformProgress {
  visible: boolean;
  type: "linear" | "circle";
  look?: StateLook;
}

export interface PlatformRead {
  /** The Carousel's own props: how it behaves and moves. */
  props: Record<string, unknown>;
  arrows?: PlatformArrows;
  indicator?: PlatformIndicator;
  progress?: PlatformProgress;
  warnings: string[];
}

const INDICATOR_KINDS: Record<string, PlatformIndicator["kind"]> = {
  bullets: "pagination",
  dots: "pagination",
  fraction: "counter",
  progressbar: "progress",
  progress: "progress",
};
const INDICATOR_BACK: Record<PlatformIndicator["kind"], string> = {
  pagination: "bullets",
  counter: "fraction",
  progress: "progressbar",
};

const raw = (n: number) => ({ raw: n, _unbound: true });

export function fromPlatformCarousel(json: PlatformCarousel, opts: PlatformReadOptions = {}): PlatformRead {
  const warnings: string[] = [];
  const color = (name: string | undefined, where: string): string | undefined => {
    if (name === undefined || name.trim() === "") return undefined;
    const leaf = name.trim();
    if (!opts.colors || opts.colors.has(leaf)) return `color.${leaf}`;
    const bare = leaf.replace(/^color_/, "");
    if (opts.colors.has(bare)) return `color.${bare}`;
    warnings.push(`${where}: "${name}" is not a colour in this theme, so it was left out`);
    return undefined;
  };
  const look = (tone: string | undefined, fill: string | undefined, where: string): StateLook | undefined => {
    const t = color(tone, `${where}.text_color`);
    const f = color(fill, `${where}.background_color`);
    return t || f ? { ...(t ? { tone: t } : {}), ...(f ? { fill: f } : {}) } : undefined;
  };

  const props: Record<string, unknown> = {};
  if (json.slides_per_view !== undefined) props.slidesPerView = json.slides_per_view;
  if (json.space_between !== undefined && json.space_between !== 0) props.gap = raw(json.space_between);
  if (json.centered_slides !== undefined) props.centered = json.centered_slides;
  if (json.direction === "horizontal" || json.direction === "vertical") props.direction = json.direction;
  if (json.loop !== undefined) props.loop = json.loop;
  if (json.free_mode !== undefined) props.freeMode = json.free_mode;
  props.autoplay =
    json.autoplay === true
      ? { delay: raw(json.autoplay_interval && json.autoplay_interval > 0 ? json.autoplay_interval : 3000) }
      : false;

  const read: PlatformRead = { props, warnings };

  const nav = json.nav_arrows;
  if (nav || json.icon) {
    const arrows: PlatformArrows = { visible: nav?.visibility === true };
    if (nav?.position === "center" || nav?.position === "top" || nav?.position === "bottom") arrows.position = nav.position;
    else if (nav?.position !== undefined) warnings.push(`nav_arrows.position: "${nav.position}" is not center, top or bottom`);
    if (nav?.sub_variant !== undefined) arrows.subVariant = nav.sub_variant;
    const enabled = look(nav?.enabled_color?.text_color, nav?.enabled_color?.background_color, "nav_arrows.enabled_color");
    if (enabled) arrows.enabled = enabled;
    const disabled = look(nav?.disabled_color?.text_color, nav?.disabled_color?.background_color, "nav_arrows.disabled_color");
    if (disabled) arrows.disabled = disabled;
    if (json.icon) arrows.icon = json.icon;
    if (nav?.variant !== undefined) arrows.variant = nav.variant;
    read.arrows = arrows;
  }

  const ind = json.nav_indicator;
  if (ind) {
    const kind = ind.type === undefined ? "pagination" : INDICATOR_KINDS[ind.type];
    if (!kind) {
      warnings.push(`nav_indicator.type: "${ind.type}" is not bullets, fraction or progressbar, so it was left out`);
    } else {
      const indicator: PlatformIndicator = { visible: ind.visibility === true, kind };
      if (ind.position === "top" || ind.position === "bottom") indicator.position = ind.position;
      else if (ind.position !== undefined) warnings.push(`nav_indicator.position: "${ind.position}" is not top or bottom`);
      if (typeof ind.offset === "number" && ind.offset !== 0) indicator.offset = ind.offset;
      if (ind.stack === "h" || ind.stack === "horizontal") indicator.stack = "horizontal";
      else if (ind.stack === "v" || ind.stack === "vertical") indicator.stack = "vertical";
      else if (ind.stack !== undefined) warnings.push(`nav_indicator.stack: "${ind.stack}" is not h or v`);
      if (ind.sub_variant === "rounded" || ind.sub_variant === "square") indicator.shape = ind.sub_variant;
      else if (ind.sub_variant !== undefined) warnings.push(`nav_indicator.sub_variant: "${ind.sub_variant}" is not rounded or square`);
      if (typeof ind.enabled_width === "number" && ind.enabled_width > 0) indicator.activeWidth = ind.enabled_width;
      // The current page's dot (or the counter's text) is `enabled`; the others are `disabled`.
      const on = color(ind.enabled_color, "nav_indicator.enabled_color");
      if (on) indicator.active = kind === "counter" ? { tone: on } : { fill: on };
      const off = color(ind.disabled_color, "nav_indicator.disabled_color");
      if (off) indicator.inactive = kind === "counter" ? { tone: off } : { fill: off };
      if (ind.variant !== undefined) indicator.variant = ind.variant;
      read.indicator = indicator;
    }
  }

  const prog = json.autoplay_progress;
  if (prog) {
    const type = prog.type === "circle" ? "circle" : "linear";
    if (prog.type && prog.type !== type) warnings.push(`autoplay_progress.type: "${prog.type}" is not linear or circle; read as linear`);
    const fill = color(prog.color, "autoplay_progress.color");
    read.progress = { visible: prog.visibility === true, type, ...(fill ? { look: { fill } } : {}) };
    if (prog.visibility === true && json.autoplay !== true) {
      warnings.push("autoplay_progress shows only while autoplay runs, and autoplay is off");
    }
  }
  return read;
}

/** `color.core_neu_700` → `core_neu_700`; nothing → "". */
const name = (ref: string | undefined) => (ref ? ref.replace(/^color\./, "") : "");
const number = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && typeof (value as { raw?: unknown }).raw === "number") {
    return (value as { raw: number }).raw;
  }
  return undefined;
};

/** What `fromPlatformCarousel` read, written back as the platform's JSON. */
export function toPlatformCarousel(read: Omit<PlatformRead, "warnings">): PlatformCarousel {
  const p = read.props;
  const autoplay = p.autoplay as false | { delay?: unknown } | undefined;
  const delay = autoplay && typeof autoplay === "object" ? number(autoplay.delay) : undefined;
  const { arrows, indicator, progress } = read;
  const lookOf = (l: StateLook | undefined) => l?.fill ?? l?.tone;
  return {
    ...(arrows?.icon ? { icon: arrows.icon } : {}),
    loop: p.loop === true,
    autoplay: Boolean(autoplay),
    direction: p.direction === "vertical" ? "vertical" : "horizontal",
    free_mode: p.freeMode === true,
    ...(arrows
      ? {
          nav_arrows: {
            ...(arrows.variant !== undefined ? { variant: arrows.variant } : {}),
            ...(arrows.position ? { position: arrows.position } : {}),
            visibility: arrows.visible,
            ...(arrows.subVariant !== undefined ? { sub_variant: arrows.subVariant } : {}),
            enabled_color: { text_color: name(arrows.enabled?.tone), background_color: name(arrows.enabled?.fill) },
            disabled_color: { text_color: name(arrows.disabled?.tone), background_color: name(arrows.disabled?.fill) },
          },
        }
      : {}),
    ...(indicator
      ? {
          nav_indicator: {
            type: INDICATOR_BACK[indicator.kind],
            stack: indicator.stack === "vertical" ? "v" : "h",
            offset: indicator.offset ?? 0,
            ...(indicator.variant !== undefined ? { variant: indicator.variant } : {}),
            position: indicator.position ?? "bottom",
            visibility: indicator.visible,
            sub_variant: indicator.shape ?? "rounded",
            enabled_color: name(lookOf(indicator.active)),
            ...(indicator.activeWidth !== undefined ? { enabled_width: indicator.activeWidth } : {}),
            disabled_color: name(lookOf(indicator.inactive)),
          },
        }
      : {}),
    space_between: number(p.gap) ?? 0,
    centered_slides: p.centered === true,
    slides_per_view: (typeof p.slidesPerView === "number" || p.slidesPerView === "auto" ? p.slidesPerView : 1) as
      | number
      | "auto",
    ...(delay !== undefined ? { autoplay_interval: delay } : {}),
    ...(progress
      ? { autoplay_progress: { type: progress.type, color: name(progress.look?.fill), visibility: progress.visible } }
      : {}),
  };
}
