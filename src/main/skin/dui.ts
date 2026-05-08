import { DOMParser, type Element } from "@xmldom/xmldom";

export interface BtnState {
  uri: string;
  color?: string;
}

export interface BtnImages {
  normal: BtnState;
  hot?: BtnState;
  pushed?: BtnState;
  disabled?: BtnState;
}

export type LayoutNode =
  | { type: "horizontal"; children: LayoutNode[] }
  | { type: "vertical"; children: LayoutNode[] }
  | {
      type: "container";
      width?: number;
      height?: number;
      children: LayoutNode[];
    }
  | { type: "control"; width?: number; height?: number }
  | { type: "button"; width: number; height: number; index: number };

export interface ElementTemplate {
  height: number;
  minWidth: number;
  maxWidth: number;
  layout: LayoutNode;
}

function parseNum(el: Element, attr: string): number | undefined {
  const v = el.getAttribute(attr);
  return v != null ? Number(v) : undefined;
}

function parseLayoutNode(
  el: Element,
  counter: { i: number }
): LayoutNode | null {
  const tag = el.tagName;
  if (tag === "HorizontalLayout") {
    return { type: "horizontal", children: parseChildren(el, counter) };
  }
  if (tag === "VerticalLayout") {
    return { type: "vertical", children: parseChildren(el, counter) };
  }
  if (tag === "Container") {
    return {
      type: "container",
      width: parseNum(el, "width"),
      height: parseNum(el, "height"),
      children: parseChildren(el, counter),
    };
  }
  if (tag === "Control") {
    return {
      type: "control",
      width: parseNum(el, "width"),
      height: parseNum(el, "height"),
    };
  }
  if (tag === "Button") {
    return {
      type: "button",
      width: parseNum(el, "width") ?? 24,
      height: parseNum(el, "height") ?? 24,
      index: counter.i++,
    };
  }
  // MenuButton and MenuLabel are part of the default element.xml template — skip them
  return null;
}

function parseChildren(parent: Element, counter: { i: number }): LayoutNode[] {
  const nodes: LayoutNode[] = [];
  for (const child of parent.children) {
    const node = parseLayoutNode(child, counter);
    if (node) nodes.push(node);
  }
  return nodes;
}

export function parseElementTemplate(xml: string): ElementTemplate | null {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml");
  } catch {
    return null;
  }

  const menuEl = doc.getElementsByTagName("MenuElement")[0];
  if (!menuEl) return null;

  const layoutEl = menuEl.getElementsByTagName("MenuElementLayout")[0];
  if (!layoutEl) return null;

  return {
    height: parseNum(menuEl, "height") ?? 30,
    minWidth: parseNum(menuEl, "minwidth") ?? 0,
    maxWidth: parseNum(menuEl, "maxwidth") ?? 300,
    layout: {
      type: "horizontal",
      children: parseChildren(layoutEl, { i: 0 }),
    },
  };
}

/** Convert #AABBGGRR (ABGR) to CSS #RRGGBBAA. */
export function abgrToCss(c: string): string {
  if (c.length === 9 && c[0] === "#") {
    return `#${c.slice(7)}${c.slice(5, 7)}${c.slice(3, 5)}${c.slice(1, 3)}`;
  }
  return c;
}

/**
 * Parse a DUI attribute string like:
 * normalimage="file='btn/play.svg' svg_color='#ff483228'" hotimage="..."
 * into structured BtnImages.
 */
export function parseBtnUrl(url: string): BtnImages | null {
  const stateRe = /(normalimage|hotimage|pushedimage|disabledimage)="([^"]*)"/g;
  const states: Record<string, BtnState> = {};

  let m;
  while ((m = stateRe.exec(url)) !== null) {
    const key = m[1].replace("image", "");
    const attrs = m[2];
    const fileMatch = attrs.match(/file='([^']*)'/);
    if (!fileMatch) continue;
    const uri = fileMatch[1];
    const colorMatch = attrs.match(/svg_color='([^']*)'/);
    const color = colorMatch?.[1];
    states[key] = { uri, color: color ? abgrToCss(color) : undefined };
  }

  if (!states.normal) return null;
  return {
    normal: states.normal,
    hot: states.hot,
    pushed: states.pushed,
    disabled: states.disabled,
  };
}
