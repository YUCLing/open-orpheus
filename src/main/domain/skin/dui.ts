import { DOMParser, type Element } from "@xmldom/xmldom";

import type {
  BtnImages,
  BtnState,
  ElementTemplate,
  LayoutNode,
} from "$sharedTypes/dui";

export type { ElementTemplate, LayoutNode };

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
    // Malformed templates are rejected by returning `null` below, so there is
    // no point in also letting xmldom print the parse failure to stderr.
    doc = new DOMParser({ onError: () => {} }).parseFromString(xml, "text/xml");
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

/** Convert #AARRGGBB (ARGB) to CSS #RRGGBBAA. */
export function argbToCss(c: string): string {
  if (c.length === 9 && c[0] === "#") {
    // input: #AA RR GG BB  (indices 1-2, 3-4, 5-6, 7-8)
    return `#${c.slice(3, 5)}${c.slice(5, 7)}${c.slice(7)}${c.slice(1, 3)}`;
  }
  return c;
}

/** Convert #AABBGGRR (ABGR) to CSS #RRGGBBAA. */
export function abgrToCss(c: string): string {
  if (c.length === 9 && c[0] === "#") {
    return `#${c.slice(7)}${c.slice(5, 7)}${c.slice(3, 5)}${c.slice(1, 3)}`;
  }
  return c;
}

/** Parse a single state attribute string like file='btn/play.svg' svg_color='#ff483228'. */
export function parseBtnState(attrs: string): BtnState | null {
  const fileMatch = attrs.match(/file='([^']*)'/);
  if (!fileMatch) return null;
  const uri = fileMatch[1];
  const colorMatch = attrs.match(/svg_color='([^']*)'/);
  const color = colorMatch?.[1];
  return { uri, color: color ? abgrToCss(color) : undefined };
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
    const state = parseBtnState(m[2]);
    if (state) states[key] = state;
  }

  if (!states.normal) return null;
  return {
    normal: states.normal,
    hot: states.hot,
    pushed: states.pushed,
    disabled: states.disabled,
  };
}
