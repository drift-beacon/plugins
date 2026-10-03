import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkPlugins, isNewestCommit, listPlugins, pendingPlugins, selectPlugin, validatePackage } from "./plugin-release.mjs";

const script = fileURLToPath(new URL("./plugin-release.mjs", import.meta.url));
const repository = "drift-beacon/plugins";

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "plugin-release-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { id: "magic-cube", version: "1.3.0" };
  const add = (directory, value = manifest) => {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, directory, "manifest.json"), JSON.stringify(value));
  };
  add("cube");
  return { root, manifest, add };
}

/** A GitHub with `releases` (tag → the manifest in its ZIP, or a whole release), `tags` and one branch head. */
async function github(t, { releases = {}, tags = [], head = "newest" } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "plugin-release-github-"));
  const server = createServer((request, response) => {
    const json = (value) => response.writeHead(value ? 200 : 404).end(JSON.stringify(value ?? { message: "Not Found" }));
    const [, kind, name] = /^\/(?:repos\/drift-beacon\/plugins\/)?(releases\/tags|git\/ref\/tags|git\/ref\/heads|download)\/(.+)$/.exec(request.url) ?? [];
    const release = releases[name];
    if (kind === "download") return response.end(readFileSync(path.join(directory, name)));
    if (kind === "git/ref/heads") return json(name === "main" ? { object: { sha: head } } : null);
    if (kind === "git/ref/tags") return json(tags.includes(name) ? { object: { sha: "tagged" } } : null);
    if (kind !== "releases/tags" || !release) return json(null);
    if (release.assets) return json({ prerelease: false, ...release });
    const id = name.replace(/-[^-]+$/, "");
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(release));
    execFileSync("zip", ["-q", "-j", path.join(directory, `${id}.zip`), path.join(directory, "manifest.json")]);
    const url = `${process.env.GITHUB_API_URL}/download/${id}.zip`;
    json({ prerelease: false, assets: [{ name: `${id}.zip`, state: "uploaded", size: 1, browser_download_url: url }] });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    server.closeAllConnections();
    delete process.env.GITHUB_API_URL;
    rmSync(directory, { recursive: true, force: true });
  });
}

/**
 * Runs the script as the workflow does, with a `gh` that records its arguments instead of publishing. Not
 * execFileSync: this process also answers as GitHub.
 */
async function run(root, command, env = {}) {
  const bin = path.join(root, ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/.gh"\n`);
  chmodSync(path.join(bin, "gh"), 0o755);
  for (const file of [".output", ".gh"]) writeFileSync(path.join(root, file), "");
  const { stdout } = await promisify(execFile)(process.execPath, [script, command], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: repository,
      GITHUB_REF: "refs/heads/main", GITHUB_SHA: "newest", GITHUB_OUTPUT: path.join(root, ".output"), ...env },
  });
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  return { stdout, output: read(".output"), gh: read(".gh").split("\n").filter(Boolean) };
}

test("selects by exact manifest identity, independently of directory name", (t) => {
  const { root, add } = fixture(t);
  add("nanoleaf", { id: "nanoleaf", version: "0.3.0" });
  assert.equal(selectPlugin(root, "magic-cube-1.3.0").directory, "cube");
  for (const tag of ["magic-cube-v1.3.0", "magic-cube-1.2.0", "v1.3.0", undefined]) {
    assert.throws(() => selectPlugin(root, tag), /advertises/);
  }
});

test("rejects what a server wouldn't advertise: duplicate IDs, prereleases and unusual folder names", (t) => {
  for (const [directory, manifest, message] of [
    ["duplicate", undefined, /Two folders/],
    ["preview", { id: "preview", version: "1.0.0-beta.1" }, /stable/],
    ["my.plugin", { id: "mine", version: "1.0.0" }, /folder names/],
  ]) {
    const { root, add } = fixture(t);
    add(directory, manifest);
    assert.throws(() => listPlugins(root), message);
  }
  const { root, add } = fixture(t);
  add(".cache", { id: "hidden" });
  add("node_modules", { id: "dependency" });
  assert.deepEqual(listPlugins(root).map((plugin) => plugin.directory), ["cube"]);
});

test("only publishes the selected package result and expected archive", (t) => {
  const { root } = fixture(t);
  const archivePath = path.join(root, "cube/releases/magic-cube.zip");
  mkdirSync(path.dirname(archivePath));
  writeFileSync(archivePath, "ZIP fixture");
  const result = { id: "magic-cube", version: "1.3.0", tag: "magic-cube-1.3.0", asset: "magic-cube.zip", archivePath };
  assert.equal(validatePackage(root, result.tag, result), archivePath);
  for (const change of [{ id: "nanoleaf" }, { version: "1.2.0" }, { tag: "other-1.3.0" }, { asset: "other.zip" }]) {
    assert.throws(() => validatePackage(root, result.tag, { ...result, ...change }), /identity/);
  }
  assert.throws(() => validatePackage(root, result.tag, { ...result, archivePath: "/tmp/other.zip" }), /path/);
  writeFileSync(archivePath, "");
  assert.throws(() => validatePackage(root, result.tag, result), /nonempty/);
});

test("a push publishes the advertised versions that have no published release", async (t) => {
  const { root, manifest, add } = fixture(t);
  add("nanoleaf", { id: "nanoleaf", version: "0.3.0" });
  await github(t, { releases: { "magic-cube-1.3.0": manifest } });
  assert.deepEqual((await pendingPlugins(root, repository)).map((plugin) => plugin.tag), ["nanoleaf-0.3.0"]);
  assert.equal((await run(root, "pending")).output, 'plugins=[{"directory":"nanoleaf","tag":"nanoleaf-0.3.0"}]\n');
});

test("a published version's manifest can't change, and its release must be one servers install", async (t) => {
  const { root, manifest, add } = fixture(t);
  add("nanoleaf", { id: "nanoleaf", version: "0.3.0" });
  add("player", { id: "cartridge-player", version: "2.0.0" });
  add("unreleased", { id: "unreleased", version: "0.1.0" });
  await github(t, { releases: {
    "magic-cube-1.3.0": manifest,
    "nanoleaf-0.3.0": { id: "nanoleaf", version: "0.3.0", description: "Before the edit" },
    "cartridge-player-2.0.0": { prerelease: true, assets: [] },
  } });
  const checked = Object.fromEntries((await checkPlugins(root, repository)).map((plugin) => [plugin.directory, plugin]));
  assert.deepEqual(checked.cube, { directory: "cube", tag: "magic-cube-1.3.0", published: true, problem: undefined });
  assert.deepEqual(checked.unreleased, { directory: "unreleased", tag: "unreleased-0.1.0", published: false, problem: undefined });
  assert.match(checked.nanoleaf.problem, /nanoleaf\/manifest\.json differs .* bump "version"/);
  assert.match(checked.player.problem, /isn't a stable release with exactly one cartridge-player\.zip/);
  await assert.rejects(run(root, "check"), /nanoleaf\/manifest\.json differs/);
});

test("only the newest commit of the branch publishes", async (t) => {
  const { root } = fixture(t);
  await github(t, { head: "newest" });
  assert.equal(await isNewestCommit(repository, "refs/heads/main", "newest"), true);
  assert.equal(await isNewestCommit(repository, "refs/heads/main", "older"), false);
  const older = await run(root, "pending", { GITHUB_SHA: "older" });
  assert.equal(older.output, "plugins=[]\n");
  assert.match(older.stdout, /no longer the newest commit/);
});

test("publishes the built ZIP at the commit it was built from, never onto a tag that already exists", async (t) => {
  const { root } = fixture(t);
  const archivePath = path.join(root, "cube/releases/magic-cube.zip");
  mkdirSync(path.dirname(archivePath));
  writeFileSync(archivePath, "ZIP fixture");
  const result = { id: "magic-cube", version: "1.3.0", tag: "magic-cube-1.3.0", asset: "magic-cube.zip", archivePath };
  writeFileSync(path.join(root, "package-result.json"), JSON.stringify(result));
  const env = { RELEASE_TAG: result.tag };
  await github(t, { tags: ["nanoleaf-0.3.0"] });
  assert.deepEqual((await run(root, "publish", env)).gh, ["release", "create", result.tag, archivePath,
    "--repo", repository, "--target", "newest", "--latest=false",
    "--title", "magic-cube 1.3.0", "--notes", "Release magic-cube-1.3.0"]);
  assert.deepEqual((await run(root, "publish", { ...env, GITHUB_SHA: "older" })).gh, []);
  await github(t, { tags: [result.tag] });
  await assert.rejects(run(root, "publish", env), /exists without a release/);
});
