// Each plugin's copies of the manifests of the plugins it uses (`<plugin>/peers/<id>.json`, from which the SDK types
// `ctx.plugins.get(id)`) against the plugins in this repository they were taken from. A copy is a snapshot, and
// nothing else notices when the plugin beside it declares something else: this does, for as long as that plugin's
// version is one the consumer's `uses` range holds. The fix is `pnpm exec dbplugin peers add ../<plugin>` in the
// consumer's folder.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const folders = json(path.join(root, "catalogue.json")).plugins;
const manifests = new Map(
  folders.map((folder) => {
    const manifest = json(path.join(root, folder, "manifest.json"));
    return [manifest.id, { folder, manifest }];
  }),
);

/** Whether `version` is in `range`: the forms the SDK takes (1.2.3, ^1.2.3, ~1.2.3, >=1.2.3 and *). */
export function inRange(version, range) {
  if (range === "*") return true;
  const [, operator = "", base] = /^(\^|~|>=)?(\d+\.\d+\.\d+)$/.exec(range) ?? [];
  if (!base) throw new Error(`Unsupported range ${range}`);
  const [major, minor, patch] = base.split(".").map(Number);
  const [vMajor, vMinor, vPatch] = version.split("+")[0].split(".").map(Number);
  const order = vMajor - major || vMinor - minor || vPatch - patch;
  if (order < 0) return false;
  if (operator === "") return order === 0;
  if (operator === ">=") return true;
  if (operator === "~") return vMajor === major && vMinor === minor;
  if (major > 0) return vMajor === major;
  if (minor > 0) return vMajor === 0 && vMinor === minor;
  return vMajor === 0 && vMinor === 0 && vPatch === patch;
}

test("the ranges a copy is held to", () => {
  for (const [version, range, held] of [
    ["0.3.0", "^0.3.0", true],
    ["0.3.9", "^0.3.0", true],
    ["0.4.0", "^0.3.0", false],
    ["1.4.0", "^1.1.0", true],
    ["2.0.0", "^1.1.0", false],
    ["1.0.9", "^1.1.0", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["9.0.0", ">=1.2.3", true],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["0.0.4", "^0.0.3", false],
    ["7.1.0", "*", true],
  ])
    assert.equal(inRange(version, range), held, `${version} in ${range}`);
});

for (const { folder, manifest } of manifests.values()) {
  const peers = path.join(root, folder, "peers");
  if (!existsSync(peers)) continue;
  for (const name of readdirSync(peers).filter((file) => file.endsWith(".json"))) {
    test(`${folder}/peers/${name} declares what the plugin beside it does`, (t) => {
      const copy = json(path.join(peers, name));
      const beside = manifests.get(copy.id);
      if (!beside) return t.skip(`${copy.id} is not a plugin of this repository`);
      const range = manifest.uses?.[copy.id];
      assert.ok(range, `${folder} holds a copy of ${copy.id}, which is not in its uses`);
      if (!inRange(beside.manifest.version, range))
        return t.skip(`${beside.folder} is at ${beside.manifest.version}, outside ${folder}'s range ${range}`);
      assert.deepEqual(
        copy.provides,
        beside.manifest.provides,
        `${beside.folder} declares something else now: run "pnpm exec dbplugin peers add ../${beside.folder}" in ${folder}`,
      );
    });
  }
}
