// Copies this project's licence, and the licences of the code bundled into server/index.mjs, into
// bundle/ so they travel with the released .mcpb file, as those licences require. Run by "npm run pack".
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BUNDLED = ["@modelcontextprotocol/server", "@modelcontextprotocol/core", "zod"];

const sections = BUNDLED.map((name) => {
  const pkg = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8"));
  const licence = readFileSync(`node_modules/${name}/LICENSE`, "utf8").trim();
  return `${"=".repeat(72)}\n${name} ${pkg.version} (${pkg.license})\n${"=".repeat(72)}\n\n${licence}\n`;
});

const notices = `This package includes the third-party code below, bundled into server/index.mjs.
The @modelcontextprotocol packages also contain code from their own dependencies, including ajv and
content-type (both MIT). See each project's repository for details.

${sections.join("\n")}`;

copyFileSync("LICENSE", "bundle/LICENSE");
writeFileSync("bundle/THIRD-PARTY-NOTICES.txt", notices);
mkdirSync("dist", { recursive: true });
console.log(`Prepared licence files for ${BUNDLED.length} bundled packages.`);
