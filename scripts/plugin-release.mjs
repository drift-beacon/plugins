import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/** Every plugin this checkout advertises: the folders catalogue.json lists, which Drift Beacon reads a manifest from. */
export function listPlugins(root) {
  const plugins = [];
  const catalogue = JSON.parse(readFileSync(path.join(root, "catalogue.json"), "utf8"));
  if (typeof catalogue.name !== "string" || !catalogue.name.trim() || !Array.isArray(catalogue.plugins)) {
    throw new Error('catalogue.json needs a "name" and a "plugins" list of folders');
  }
  for (const directory of catalogue.plugins) {
    if (typeof directory !== "string" || !/^[a-zA-Z0-9_-]+$/.test(directory)) {
      throw new Error(`Plugin folder names use only letters, digits, - and _: ${directory}`);
    }
    const file = path.join(root, directory, "manifest.json");
    if (!existsSync(file)) throw new Error(`catalogue.json lists ${directory}, which has no manifest.json`);
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.id) ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(manifest.version)) {
      throw new Error(`${directory}/manifest.json needs a plugin ID and a stable semantic version`);
    }
    if (plugins.some((plugin) => plugin.manifest.id === manifest.id)) {
      throw new Error(`Two folders advertise the plugin ID ${manifest.id}`);
    }
    plugins.push({ directory, manifest, tag: `${manifest.id}-${manifest.version}` });
  }
  return plugins;
}

export function selectPlugin(root, tag) {
  const plugin = listPlugins(root).find((candidate) => candidate.tag === tag);
  if (!plugin) throw new Error(`No plugin manifest advertises ${tag}: tags are <id>-<version>`);
  return plugin;
}

export function validatePackage(root, tag, result) {
  const { directory, manifest } = selectPlugin(root, tag);
  if (result.id !== manifest.id || result.version !== manifest.version || result.tag !== tag ||
      result.asset !== `${manifest.id}.zip`) {
    throw new Error("Package identity does not match the advertised manifest");
  }
  const archivePath = path.join(path.resolve(root), directory, "releases", result.asset);
  if (result.archivePath !== archivePath) throw new Error("Unexpected package archive path");
  const archive = statSync(archivePath);
  if (!archive.isFile() || archive.size === 0 || archive.size > MAX_ARCHIVE_BYTES) {
    throw new Error("Expected a nonempty plugin ZIP no larger than 32 MiB");
  }
  return archivePath;
}

/** GitHub's REST API, as the workflow's token or anonymously on your own machine. A 404 is `null`. */
async function github(pathname) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}/${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${pathname}`);
  return response.json();
}

/** The lookup Drift Beacon makes before installing. A draft has no tag yet, so only a published release answers. */
const publishedRelease = (repository, tag) => github(`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);

/** The manifest inside a release's ZIP, or `undefined` when the release isn't one a server installs from. */
async function releasedManifest(release, id) {
  const assets = release.assets.filter((asset) => asset.name === `${id}.zip`);
  const asset = assets[0];
  if (release.prerelease || assets.length !== 1 || asset.state !== "uploaded" || asset.size > MAX_ARCHIVE_BYTES) {
    return undefined;
  }
  const response = await fetch(asset.browser_download_url);
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${asset.browser_download_url}`);
  const directory = mkdtempSync(path.join(os.tmpdir(), "plugin-release-"));
  try {
    const archive = path.join(directory, asset.name);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    return JSON.parse(execFileSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The advertised versions with no published release yet: what a push to the default branch publishes. */
export async function pendingPlugins(root, repository) {
  const pending = [];
  for (const plugin of listPlugins(root)) {
    if (!(await publishedRelease(repository, plugin.tag))) pending.push(plugin);
  }
  return pending;
}

/**
 * Every advertised plugin, with what would stop a server installing its release. Drift Beacon installs only when the
 * manifest in the release's ZIP equals the advertised one, so a published version's manifest can never change.
 */
export async function checkPlugins(root, repository) {
  const checked = [];
  for (const { directory, manifest, tag } of listPlugins(root)) {
    const release = await publishedRelease(repository, tag);
    const released = release && (await releasedManifest(release, manifest.id));
    let problem;
    if (release && !released) {
      problem = `${tag} isn't a stable release with exactly one ${manifest.id}.zip, so servers refuse to install it. ` +
        `Bump "version" to publish a new one`;
    } else if (release && !isDeepStrictEqual(released, manifest)) {
      problem = `${directory}/manifest.json differs from the manifest published in ${tag}, so servers refuse to ` +
        `install it. A published version can't change: bump "version"`;
    }
    checked.push({ directory, tag, published: !!release, problem });
  }
  return checked;
}

/** Only the newest commit publishes: an older run would release a manifest the branch has moved on from. */
export async function isNewestCommit(repository, ref, sha) {
  const head = await github(`repos/${repository}/git/ref/${ref.slice("refs/".length)}`);
  return head?.object.sha === sha;
}

function originRepository() {
  const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  const match = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(url);
  if (!match) throw new Error("Set GITHUB_REPOSITORY=owner/name: origin is not a GitHub repository");
  return match[1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd();
  const repository = process.env.GITHUB_REPOSITORY || originRepository();
  const { GITHUB_REF: ref, GITHUB_SHA: sha } = process.env;
  const superseded = `::notice::${sha} is no longer the newest commit on ${ref}: the run for the newest one publishes`;
  if (process.argv[2] === "check") {
    for (const { directory, tag, published, problem } of await checkPlugins(root, repository)) {
      const state = problem ? "can't be installed" : published ? "published" : "not published yet";
      console.log(`${tag}: ${state}`);
      if (!problem) continue;
      console.error(process.env.GITHUB_ACTIONS ? `::error file=${directory}/manifest.json::${problem}` : problem);
      process.exitCode = 1;
    }
  } else if (process.argv[2] === "pending") {
    const newest = await isNewestCommit(repository, ref, sha);
    const pending = newest ? await pendingPlugins(root, repository) : [];
    if (!newest) console.log(superseded);
    else console.log(pending.length ? `To publish: ${pending.map((plugin) => plugin.tag).join(", ")}` : "Nothing to publish");
    const plugins = pending.map(({ directory, tag }) => ({ directory, tag }));
    appendFileSync(process.env.GITHUB_OUTPUT, `plugins=${JSON.stringify(plugins)}\n`);
  } else if (process.argv[2] === "publish") {
    const tag = process.env.RELEASE_TAG;
    const result = JSON.parse(readFileSync("package-result.json", "utf8"));
    const archivePath = validatePackage(root, tag, result);
    if (!(await isNewestCommit(repository, ref, sha))) {
      console.log(superseded);
    } else if (await github(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`)) {
      // gh would attach the release to the commit that tag points at, not the one this ZIP was built from.
      throw new Error(`The tag ${tag} exists without a release. Delete it if it was pushed by hand; otherwise bump "version"`);
    } else {
      // gh uploads the ZIP to a draft and publishes last, the order immutable releases need. It refuses an existing release.
      execFileSync("gh", ["release", "create", tag, archivePath,
        "--repo", repository, "--target", sha, "--latest=false",
        "--title", `${result.id} ${result.version}`, "--notes", `Release ${tag}`], { stdio: "inherit" });
    }
  } else {
    throw new Error("Usage: node scripts/plugin-release.mjs check|pending|publish");
  }
}
