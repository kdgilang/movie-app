import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync, existsSync, rmSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");

if (existsSync(dist)) {
  rmSync(dist, { recursive: true });
}
mkdirSync(dist, { recursive: true });

copyFileSync(join(root, "appinfo.json"), join(dist, "appinfo.json"));
copyFileSync(join(root, "index.html"), join(dist, "index.html"));
copyFileSync(join(root, "styles.css"), join(dist, "styles.css"));
copyFileSync(join(root, "src", "webOSTV.js"), join(dist, "webOSTV.js"));

/** Bullix accent #ffa800 — placeholder when custom icons are missing */
async function writeSolidPng(outPath, w, h) {
  const png = new PNG({ width: w, height: h });
  const r = 0xff;
  const g = 0xa8;
  const b = 0x00;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (w * y + x) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  await new Promise((resolve, reject) => {
    png
      .pack()
      .pipe(createWriteStream(outPath))
      .on("finish", resolve)
      .on("error", reject);
  });
}

if (existsSync(join(root, "icon.png"))) {
  copyFileSync(join(root, "icon.png"), join(dist, "icon.png"));
} else {
  await writeSolidPng(join(dist, "icon.png"), 80, 80);
}
if (existsSync(join(root, "icon-large.png"))) {
  copyFileSync(join(root, "icon-large.png"), join(dist, "icon-large.png"));
} else {
  await writeSolidPng(join(dist, "icon-large.png"), 130, 130);
}

const legacyTarget = ["chrome53"];

await esbuild.build({
  entryPoints: [join(root, "src", "main.js")],
  bundle: true,
  outfile: join(dist, "app.js"),
  format: "iife",
  platform: "browser",
  target: legacyTarget,
  sourcemap: true,
  minify: false,
  legalComments: "none",
});

await esbuild.build({
  entryPoints: [join(root, "src", "hls-bundle.js")],
  bundle: true,
  outfile: join(dist, "hls.bundle.js"),
  format: "iife",
  platform: "browser",
  target: legacyTarget,
  sourcemap: true,
  minify: false,
  legalComments: "none",
});

console.log(
  "Built webos/dist (app.js, hls.bundle.js, index.html, styles.css, appinfo.json, icons)"
);
