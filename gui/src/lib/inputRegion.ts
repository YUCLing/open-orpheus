import type { Attachment } from "svelte/attachments";

import type { InputRegionContract } from "$bridge/contracts/input-region-api";

import { getBridge } from "./bridge";

const api = getBridge<InputRegionContract>("inputRegion");
const inputRegionElements: Element[] = [];

let rAFId: number | null = null;
const cachedBounds: number[] = [];

export async function refreshInputRegion() {
  if (api.platform === "linux") {
    return await api.setInputRegions(
      inputRegionElements.map((v) => {
        const bounding = v.getBoundingClientRect();
        return {
          x: bounding.left,
          y: bounding.top,
          width: bounding.width,
          height: bounding.height,
        };
      })
    );
  } else {
    // On Windows/macOS, `setIgnoreMouseEvent` is used instead of actual setting input regions
    for (const el of inputRegionElements) {
      if (el.matches(":hover")) {
        // Enable input
        return await api.setInputRegions([]);
      }
    }
    // Dummy region to disable input
    return await api.setInputRegions([{ x: 0, y: 0, width: 1, height: 1 }]);
  }
}

function tick() {
  const len = inputRegionElements.length;
  let cacheIdx = 0;
  let anyChanged = false;

  for (let i = 0; i < len; i++) {
    const rect = inputRegionElements[i].getBoundingClientRect();

    if (
      cachedBounds[cacheIdx] !== rect.top ||
      cachedBounds[cacheIdx + 1] !== rect.left ||
      cachedBounds[cacheIdx + 2] !== rect.width ||
      cachedBounds[cacheIdx + 3] !== rect.height
    ) {
      cachedBounds[cacheIdx] = rect.top;
      cachedBounds[cacheIdx + 1] = rect.left;
      cachedBounds[cacheIdx + 2] = rect.width;
      cachedBounds[cacheIdx + 3] = rect.height;
      anyChanged = true;
    }
    cacheIdx += 4;
  }

  rAFId = requestAnimationFrame(tick);

  if (anyChanged) {
    refreshInputRegion();
  }
}

export function addInputRegion(el: Element) {
  inputRegionElements.push(el);

  if (api.platform === "linux") {
    const rect = el.getBoundingClientRect();
    cachedBounds.push(rect.top, rect.left, rect.width, rect.height);

    if (rAFId === null) {
      rAFId = requestAnimationFrame(tick);
    }
  } else if (el instanceof HTMLElement) {
    el.addEventListener("mouseenter", refreshInputRegion);
    el.addEventListener("mouseleave", refreshInputRegion);
  }

  refreshInputRegion();
}

export function removeInputRegion(el: Element) {
  const index = inputRegionElements.indexOf(el);
  if (index > -1) {
    if (api.platform === "linux") {
      cachedBounds.splice(index * 4, 4);
    }
    inputRegionElements.splice(index, 1);
  }

  if (api.platform === "linux") {
    if (rAFId && inputRegionElements.length === 0) {
      cancelAnimationFrame(rAFId);
      rAFId = null;
    }
  } else {
    if (el instanceof HTMLElement) {
      el.removeEventListener("mouseenter", refreshInputRegion);
      el.removeEventListener("mouseleave", refreshInputRegion);
    }
  }

  refreshInputRegion();
}

export const inputRegionAttachment: Attachment = (element) => {
  addInputRegion(element);
  return () => {
    removeInputRegion(element);
  };
};

api.events.shown(async () => {
  // Ensure it's set, even if it was populated before window surface is
  // actually shown.
  for (let i = 0; i < 5; i++) {
    if (await refreshInputRegion()) return;
    await new Promise((r) => setTimeout(r, (i + 1) * 100));
  }
});
