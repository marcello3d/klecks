// Builds the Klecks embed and assembles dist-2draw/ with only the runtime files 2draw.net
// serves from /applet/klecks/: the bundles, chunks, fonts and images, help.html, no source
// maps. Also LICENSE.txt (Klecks's MIT license) and VERSION ("Klecks 2draw@<commit>").
// Copy dist-2draw/* there (2draw keeps its own kleki-2draw.js and README.md next to them).
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const out = join(root, "dist-2draw");
const run = (cmd, env) => execSync(cmd, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
const sha = execSync("git rev-parse --short=8 HEAD", { cwd: root }).toString().trim();
const dirty = execSync("git status --porcelain --untracked-files=no", { cwd: root }).toString().trim() ? "-dirty" : "";

// The generated icons and languages (src/app/icons, src/app/languages) first, as the README says.
run("npm run icon:build");
run("npm run lang:build");
rmSync(dist, { recursive: true, force: true });
// KLECKS_BUILD: the build a .klr recording names in its HEAD
run("npx parcel build src/embed.ts src/help.html --public-url . --no-source-maps --no-cache", { KLECKS_BUILD: sha + dirty });

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of readdirSync(dist, { withFileTypes: true })) {
    if (f.isFile() && !f.name.endsWith(".map")) copyFileSync(join(dist, f.name), join(out, f.name));
}
copyFileSync(join(root, "LICENSE"), join(out, "LICENSE.txt"));

writeFileSync(join(out, "VERSION"), `Klecks 2draw@${sha}${dirty}\n`);
console.log(`dist-2draw/ built from ${sha}${dirty}`);
