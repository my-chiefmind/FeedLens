// Bundles src/ into dist/, the folder Chrome loads as an unpacked extension.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const out = "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out);

await build({
  entryPoints: ["src/background.js", "src/content.js", "src/options.js", "src/popup.js"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: out,
  logLevel: "warning",
});

for (const f of ["manifest.json", "content.css", "options.html", "popup.html"]) cpSync(`src/${f}`, `${out}/${f}`);
cpSync("src/icons", `${out}/icons`, { recursive: true });
cpSync("docs/HOW-TO-INSTALL.html", `${out}/docs/HOW-TO-INSTALL.html`);
console.log("Built dist/");
