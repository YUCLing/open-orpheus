import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import ejs from "ejs";

const template = resolve(
  import.meta.dirname,
  "../resources/open-orpheus.desktop.ejs"
);

export interface DesktopFileOptions {
  executable?: string;
  icon?: string;
}

export async function generateDesktop(options: DesktopFileOptions = {}) {
  return new Promise<string>((resolve, reject) => {
    ejs.renderFile(
      template,
      {
        executable: options.executable,
        icon: options.icon,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
  });
}

export async function createDesktopFile(
  path: string,
  options: DesktopFileOptions = {}
) {
  const result = await generateDesktop(options);
  await writeFile(path, result, { encoding: "utf-8" });
}
