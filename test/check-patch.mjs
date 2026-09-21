/**
 * Validate the mounted profile patch: it must parse as the loader's patch-list
 * dialect and must mount dsh-memory with a config the plugin accepts.
 *
 * Run with the profile's own js-yaml:
 *   node --input-type=module -e "..."   (or from a directory that resolves it)
 */

import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { resolveOptions } from "../lib/render.js";

const patchPath = process.argv[2];
if (patchPath === undefined) throw new Error("usage: check-patch.mjs <cordis.patch.yml>");

const parsed = load(readFileSync(patchPath, "utf8"));
if (!Array.isArray(parsed)) throw new Error("the profile patch must be a top-level YAML array");

const entries = parsed.flatMap((layer) => layer?.insert ?? []);
const names = entries.map((entry) => entry.name);
if (!names.includes("dsh-memory")) throw new Error(`dsh-memory is not mounted; found: ${names.join(", ") || "(none)"}`);

const row = entries.find((entry) => entry.name === "dsh-memory");
if (row.id !== "memory") throw new Error(`unexpected row id: ${String(row.id)}`);
const options = resolveOptions(row.config);
if (!options.domains.includes("core")) throw new Error("core must always be a domain");
if (row.config.injectChars !== undefined && options.injectChars !== row.config.injectChars) {
	throw new Error(`injectChars not applied: config says ${row.config.injectChars}, resolved ${options.injectChars}`);
}
// `bootUris` is expected to be filled in over time, so this checks that whatever
// is there RESOLVES (each entry names a memory-looking URI) rather than that it
// is empty. Assuming emptiness made the check fail once the user configured it.
for (const uri of options.bootUris) {
	if (!/^[a-z][a-z0-9-]*:\/\//u.test(uri)) throw new Error(`bootUris entry is not a URI: ${JSON.stringify(uri)}`);
}
for (const domain of options.globalDomains) {
	if (!options.domains.includes(domain)) {
		throw new Error(`globalDomains lists "${domain}", which is not in domains (${options.domains.join(", ")})`);
	}
}

console.log("profile patch check: OK");
console.log(`  entries: ${names.join(", ")}`);
console.log(`  storeDir: ${options.storeDir}`);
console.log(`  domains: ${options.domains.join(", ")}`);
console.log(`  globalDomains: ${options.globalDomains.join(", ")}`);
console.log(`  bootUris: ${options.bootUris.length === 0 ? "(none yet)" : options.bootUris.join(", ")}`);
console.log(`  injectChars: ${options.injectChars}, workingLimit: ${options.workingLimit}, pressureRatio: ${options.pressureRatio}`);
console.log(`  showOtherWorkspaces: ${options.showOtherWorkspaces}`);
