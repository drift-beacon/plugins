// The C++ compiler behind the firmware's host tests, and what to say on a machine that has none. Shared by the test
// files that compile firmware sources (tests/firmware.test.mjs), so they pick the compiler and word its absence alike.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `CXX` picks the compiler; any C++17 one will do. */
export const CXX = process.env.CXX || "c++";

/**
 * Null when the compiler is there. Otherwise one sentence to fail or skip with, naming what goes unchecked without
 * it (`unchecked` completes "…; <unchecked> not checked"). Only a missing compiler counts: one that runs and then
 * rejects the sources must fail with its own errors.
 */
export async function missingCompiler(unchecked) {
  try {
    await run(CXX, ["--version"]);
  } catch (error) {
    if (error.code === "ENOENT") return `No C++17 compiler (${CXX}): install one or set CXX; ${unchecked} not checked`;
  }
  return null;
}
