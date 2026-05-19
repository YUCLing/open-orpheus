import type { Attachment } from "svelte/attachments";

import type { InputRegionContract } from "$bridge/contracts/input-region-api";

import { getBridge } from "./bridge";

const api = getBridge<InputRegionContract>("inputRegion");
const inputRegionElements: Element[] = [];

export function refreshInputRegion() {
  if (api.platform === "linux") {
    api.setInputRegions(
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
        api.setInputRegions([]);
        return;
      }
    }
    // Dummy region to disable input
    api.setInputRegions([{ x: 0, y: 0, width: 1, height: 1 }]);
  }
}

export function addInputRegion(el: Element) {
  inputRegionElements.push(el);
  if (el instanceof HTMLElement) {
    el.addEventListener("mouseenter", refreshInputRegion);
    el.addEventListener("mouseleave", refreshInputRegion);
  }
  refreshInputRegion();
}

export function removeInputRegion(el: Element) {
  inputRegionElements.splice(inputRegionElements.indexOf(el), 1);
  if (el instanceof HTMLElement) {
    el.removeEventListener("mouseenter", refreshInputRegion);
    el.removeEventListener("mouseleave", refreshInputRegion);
  }
  refreshInputRegion();
}

export const inputRegionAttachment: Attachment = (element) => {
  addInputRegion(element);
  return () => {
    removeInputRegion(element);
  };
};

api.events.shown(() => {
  // Ensure it's set, even if it was populated before window surface is
  // actually shown.
  refreshInputRegion();
});
