import type { ElementTemplate } from "@shared/types/dui";

// Template cache: style path → parsed template
const templateCache: Record<string, ElementTemplate> = {};

/** Store pre-parsed templates from the main process. */
export function loadTemplates(parsedTemplates: Record<string, ElementTemplate>) {
  Object.assign(templateCache, parsedTemplates);
}

/** Get cached template synchronously (must be preloaded). */
export function getCachedTemplate(style: string): ElementTemplate | null {
  return templateCache[style] ?? null;
}
