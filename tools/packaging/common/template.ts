import { writeFile } from "node:fs/promises";

import ejs from "ejs";

/** Render an EJS template with `ejs.renderFile`, returning the result. */
export function renderTemplate(templatePath: string, data: object): Promise<string> {
  return new Promise((resolve, reject) => {
    ejs.renderFile(templatePath, data, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/** Render `templatePath` and write it to `dest` as UTF-8. */
export async function writeTemplate(
  dest: string,
  templatePath: string,
  data: object
): Promise<void> {
  await writeFile(dest, await renderTemplate(templatePath, data), { encoding: "utf-8" });
}
