import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("static DOM IDs referenced by event handlers exist in the page", async () => {
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  const missing = [];
  for (const file of ["app.js", "calendar.js", "shared.js", "group-deletion.mjs", "profile.js", "notifications.mjs", "shared-event-editor.mjs"]) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\$\(["']([^"']+)["']\)/g)) {
      if (!ids.has(match[1])) missing.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});
