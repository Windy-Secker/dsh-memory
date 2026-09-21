/**
 * Point the profile patch's `bootUris` at a new set of URIs.
 *
 * Only the `bootUris` line and its list items are rewritten; every other setting
 * (`storeDir`, `globalDomains`, the balance badge, the comments) is left byte for
 * byte. The installer refuses to rebuild a customized row for exactly this
 * reason, so this is the surgical alternative when the URIs themselves change.
 *
 * Usage: node retarget-boot-uris.mjs <cordis.patch.yml> <uri> [uri...]
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const [patchPath, ...uris] = process.argv.slice(2);
if (patchPath === undefined || uris.length === 0) throw new Error("usage: retarget-boot-uris.mjs <patch> <uri> [uri...]");
for (const uri of uris) {
	if (!/^[a-z][a-z0-9-]*:\/\//u.test(uri)) throw new Error(`not a memory URI: ${JSON.stringify(uri)}`);
}

const source = readFileSync(patchPath, "utf8");
if (!source.includes("dsh-memory")) throw new Error(`${patchPath} does not mount dsh-memory`);

const backup = `${patchPath}.bak-${new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14)}`;
copyFileSync(patchPath, backup);

const lines = source.split(/\r?\n/);
const start = lines.findIndex((line) => /^\s+bootUris\s*:/u.test(line));
const indent = start >= 0 ? /^(\s+)/u.exec(lines[start])[1] : "        ";
const itemIndent = `${indent}  `;
let end = start;
if (start >= 0) {
	let index = start + 1;
	while (index < lines.length && (/^\s+-\s/u.test(lines[index]) || lines[index].trim().length === 0)) {
		if (lines[index].trim().length === 0) break;
		index += 1;
	}
	end = index;
}

const block = ["bootUris:", ...uris.map((uri) => `${itemIndent}- '${uri}'`)].map((line, index) =>
	index === 0 ? `${indent}${line}` : line,
);

const next =
	start < 0
		? [...lines.slice(0, lines.length), `${indent}bootUris:`, ...uris.map((uri) => `${itemIndent}- '${uri}'`)].join("\n")
		: [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");

writeFileSync(patchPath, `${next.trimEnd()}\n`, "utf8");
console.log(`rewrote bootUris in ${patchPath}`);
console.log(`  backup: ${backup}`);
for (const uri of uris) console.log(`  - ${uri}`);
