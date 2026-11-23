import { resolve } from "node:path";

import { renderTemplate, writeTemplate } from "./template.ts";

const template = resolve(import.meta.dirname, "../resources/open-orpheus.desktop.ejs");

export interface DesktopFileOptions {
  executable?: string;
  icon?: string;
}

export async function generateDesktop(options: DesktopFileOptions = {}) {
  return renderTemplate(template, {
    executable: options.executable,
    icon: options.icon,
  });
}

export async function createDesktopFile(path: string, options: DesktopFileOptions = {}) {
  await writeTemplate(path, template, {
    executable: options.executable,
    icon: options.icon,
  });
}
