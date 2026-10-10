import { existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { UpdaterError, assertSafeRelativeSegment, nowIso, readJsonIfPresent, atomicWriteJson, redact, versionKey } from "./util.mjs";

export const INSTALL_LAYOUT = {
  versionsDirName: "versions",
  sharedDirName: "shared",
  currentJsonName: "current.json",
  currentJunctionName: "current",
  stagingPrefix: ".staging-",
  trashPrefix: ".trash-",
  stagedMarker: ".staged-ok",
};

export function layoutPaths(installRoot) {
  return {
    installRoot,
    versionsDir: path.join(installRoot, "versions"),
    sharedDir: path.join(installRoot, "shared"),
    sharedVarDir: path.join(installRoot, "shared", "var"),
    sharedWorkspacesDir: path.join(installRoot, "shared", "workspaces"),
    currentJson: path.join(installRoot, "current.json"),
    currentJunction: path.join(installRoot, "current"),
  };
}

export async function detectLiveVersion(liveRoot) {
  const manifestPath = path.join(liveRoot, "PACKAGE-MANIFEST.json");
  const manifest = await readJsonIfPresent(manifestPath);
  if (manifest && typeof manifest.version === "string" && manifest.version.trim()) {
    return { version: manifest.version.trim().replace(/^v/i, ""), source: "PACKAGE-MANIFEST.json" };
  }
  if (manifest && typeof manifest.package === "string") {
    const match = manifest.package.match(/^A446-MultiDevice-LAN-(.+)-(\d{8})$/);
    if (match) {
      return { version: match[1].replace(/^v/i, ""), source: "PACKAGE-MANIFEST.json(package)" };
    }
    throw new UpdaterError(
      `Cannot derive version from PACKAGE-MANIFEST.json package name: ${redact(manifest.package)}`,
      { code: "VERSION_UNREADABLE", exitCode: 15 },
    );
  }
  const dirname = path.basename(path.resolve(liveRoot));
  const match = dirname.match(/^A446-MultiDevice-LAN-(.+?)-(\d{8})$/) ?? dirname.match(/^A446-MultiDevice-LAN-(.+)$/);
  if (match) {
    return { version: match[1].replace(/^v/i, ""), source: "directory-name" };
  }
  throw new UpdaterError(
    `Cannot determine the current version of ${redact(liveRoot)}. PACKAGE-MANIFEST.json is missing or has no version.`,
    { code: "VERSION_UNREADABLE", exitCode: 15 },
  );
}

export function isJunction(linkPath) {
  try {
    const stats = lstatSync(linkPath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

export function readJunctionTarget(linkPath) {
  return readlinkSync(linkPath);
}

export function createJunction(linkPath, targetPath) {
  const resolvedTarget = path.resolve(targetPath);
  if (!existsSync(resolvedTarget)) {
    throw new UpdaterError(`Junction target does not exist: ${redact(resolvedTarget)}`, { code: "JUNCTION_TARGET_MISSING", exitCode: 15 });
  }
  if (existsSync(linkPath)) {
    throw new UpdaterError(`Junction path already exists: ${redact(linkPath)}`, { code: "JUNCTION_PATH_EXISTS", exitCode: 15 });
  }
  symlinkSync(resolvedTarget, linkPath, "junction");
}

/**
 * Removes a junction without ever touching its target contents.
 * Refuses to operate on a real directory: only reparse points are removed.
 */
export async function removeJunction(linkPath) {
  if (!existsSync(linkPath)) return;
  const stats = lstatSync(linkPath);
  if (!stats.isSymbolicLink()) {
    throw new UpdaterError(
      `Refusing to remove ${redact(linkPath)}: it is a real directory, not a junction.`,
      { code: "NOT_A_JUNCTION", exitCode: 15 },
    );
  }
  const target = readlinkSync(linkPath);
  await fs.rmdir(linkPath);
  if (!existsSync(target)) {
    throw new UpdaterError(
      `Junction target vanished after removing junction ${redact(linkPath)} -> ${redact(target)}`,
      { code: "JUNCTION_TARGET_LOST", exitCode: 15 },
    );
  }
}

export async function writeCurrentJson(installRoot, { version, target }) {
  const paths = layoutPaths(installRoot);
  await atomicWriteJson(paths.currentJson, {
    schemaVersion: 1,
    version,
    target,
    updatedAt: nowIso(),
  });
}

export async function readCurrentJson(installRoot) {
  const paths = layoutPaths(installRoot);
  const value = await readJsonIfPresent(paths.currentJson);
  if (!value) return null;
  if (typeof value.version !== "string" || typeof value.target !== "string") {
    throw new UpdaterError("current.json is missing required fields", { code: "STATE_CORRUPT", exitCode: 16 });
  }
  return value;
}

/**
 * The junction under installRoot is the physical truth; current.json is the
 * recorded truth. When they disagree the junction wins and the JSON is fixed.
 */
export async function resolveCurrentTarget(installRoot) {
  const paths = layoutPaths(installRoot);
  if (!isJunction(paths.currentJunction)) {
    return null;
  }
  const target = readJunctionTarget(paths.currentJunction);
  const recorded = await readCurrentJson(installRoot).catch(() => null);
  if (recorded && path.resolve(installRoot, recorded.target) !== path.resolve(target)) {
    const version = await versionFromVersionDir(target);
    await writeCurrentJson(installRoot, { version, target: relativeTarget(installRoot, target) });
    return { version, target: relativeTarget(installRoot, target), repaired: true };
  }
  if (!recorded) {
    const version = await versionFromVersionDir(target);
    await writeCurrentJson(installRoot, { version, target: relativeTarget(installRoot, target) });
    return { version, target: relativeTarget(installRoot, target), repaired: true };
  }
  return { version: recorded.version, target: recorded.target, repaired: false };
}

function relativeTarget(installRoot, absoluteTarget) {
  const relative = path.relative(path.resolve(installRoot), path.resolve(absoluteTarget));
  return relative.replaceAll("\\", "/");
}

async function versionFromVersionDir(absoluteTarget) {
  const marker = await readJsonIfPresent(path.join(absoluteTarget, ".a446-version.json"));
  if (marker && typeof marker.version === "string") return marker.version;
  const detected = await detectLiveVersion(absoluteTarget);
  return detected.version;
}

export function versionDirPath(installRoot, version) {
  const key = versionKey(version);
  assertSafeRelativeSegment(key, "version directory key");
  return path.join(installRoot, "versions", key);
}

export async function ensureSharedJunctions(versionDir, installRoot) {
  const paths = layoutPaths(installRoot);
  await fs.mkdir(paths.sharedVarDir, { recursive: true });
  await fs.mkdir(paths.sharedWorkspacesDir, { recursive: true });
  const varPath = path.join(versionDir, "apps", "agent-hub", "var");
  const workspacesPath = path.join(versionDir, "apps", "agent-hub", "workspaces");
  await fs.mkdir(path.dirname(varPath), { recursive: true });
  await fs.mkdir(path.dirname(workspacesPath), { recursive: true });
  if (!existsSync(varPath)) createJunction(varPath, paths.sharedVarDir);
  if (!existsSync(workspacesPath)) createJunction(workspacesPath, paths.sharedWorkspacesDir);
}

/**
 * One-time migration from the flat layout to versions+shared+junction layout.
 * Journal-backed: the version key is recorded before the first destructive
 * step, every step is recorded after it completes, and each step is guarded,
 * so an interrupted migration (power loss at any point) resumes safely on the
 * next invocation. Re-running adopt after a completed migration is
 * idempotent (returns `alreadyAdopted`), and a live junction with a matching
 * journal resumes the remaining steps instead of being rejected.
 *
 * `hooks.after(step)` is invoked after each step is journalled (fault
 * injection point used by tests to simulate power loss mid-migration).
 */
export async function adoptLayout({ livePath, installRoot, journalFile, logger, hooks }) {
  const log = logger ?? (() => {});
  const live = path.resolve(livePath);
  const root = path.resolve(installRoot);
  const paths = layoutPaths(root);
  const afterStep = (step) => hooks?.after?.(step);

  // Read the journal FIRST: a live junction (or a missing live path) with a
  // matching journal means an interrupted migration that must be resumed,
  // not rejected.
  const rawJournal = await readJsonIfPresent(journalFile).catch(() => null);
  const journal = rawJournal ?? { steps: [], livePath: live, installRoot: root, versionKey: null };
  const journalMatches = path.resolve(journal.livePath ?? "") === live
    && path.resolve(journal.installRoot ?? "") === root;
  const resume = journalMatches && Array.isArray(journal.steps) && journal.steps.length > 0;

  if (!resume) {
    if (rawJournal && !journalMatches) {
      throw new UpdaterError(
        `The migration journal at ${redact(journalFile)} belongs to a different migration ` +
        `(live ${redact(String(journal.livePath))}, root ${redact(String(journal.installRoot))}). ` +
        `Resolve it manually before running adopt.`,
        { code: "STATE_CORRUPT", exitCode: 16 },
      );
    }
    if (isJunction(live)) {
      // No journal: the only safe interpretation of a live junction is an
      // already-completed adoption. Verify the full layout before saying so.
      const current = await resolveCurrentTarget(root).catch(() => null);
      const liveTarget = (() => { try { return readJunctionTarget(live); } catch { return null; } })();
      if (current && liveTarget && path.resolve(liveTarget) === path.resolve(paths.currentJunction)) {
        log(`already adopted: ${redact(live)} -> version ${current.version}`);
        return { installRoot: root, livePath: live, version: current.version, alreadyAdopted: true };
      }
      throw new UpdaterError(
        `Live path ${redact(live)} is a junction but the layout under ${redact(root)} is incomplete ` +
        `and no migration journal exists. Manual intervention required.`,
        { code: "STATE_CORRUPT", exitCode: 16 },
      );
    }
    if (!existsSync(live)) {
      throw new UpdaterError(`Live path does not exist: ${redact(live)}`, { code: "NOT_AN_A446_INSTALL", exitCode: 4 });
    }
    if (!existsSync(path.join(live, "apps", "agent-hub", "src", "worker.mjs"))) {
      throw new UpdaterError(
        `${redact(live)} does not look like an A446 Multi-Device LAN package (apps/agent-hub/src/worker.mjs is missing).`,
        { code: "NOT_AN_A446_INSTALL", exitCode: 4 },
      );
    }
  }

  // Resolve the version key and journal it BEFORE the first destructive step
  // so a resumed run can always find the version directory.
  let key;
  if (resume && typeof journal.versionKey === "string" && journal.versionKey) {
    key = journal.versionKey;
  } else {
    const detected = await detectLiveVersion(live);
    key = versionKey(detected.version);
    journal.versionKey = key;
    await atomicWriteJson(journalFile, journal);
  }
  const versionDir = path.join(paths.versionsDir, key);

  const done = new Set(journal.steps);
  const mark = async (step) => {
    if (!done.has(step)) {
      journal.steps.push(step);
      await atomicWriteJson(journalFile, journal);
      done.add(step);
      afterStep(step);
    }
  };

  if (!done.has("mkdirs")) {
    await fs.mkdir(paths.versionsDir, { recursive: true });
    await fs.mkdir(paths.sharedDir, { recursive: true });
    await mark("mkdirs");
  }
  const oldVar = path.join(live, "apps", "agent-hub", "var");
  const oldWorkspaces = path.join(live, "apps", "agent-hub", "workspaces");
  if (!done.has("move-var")) {
    if (existsSync(oldVar)) {
      if (isJunction(oldVar)) {
        // Already linked (resumed migration); nothing to move.
      } else {
        await fs.rename(oldVar, paths.sharedVarDir);
      }
    } else {
      await fs.mkdir(paths.sharedVarDir, { recursive: true });
    }
    await mark("move-var");
  }
  if (!done.has("move-workspaces")) {
    if (existsSync(oldWorkspaces)) {
      if (!isJunction(oldWorkspaces)) {
        await fs.rename(oldWorkspaces, paths.sharedWorkspacesDir);
      }
    } else {
      await fs.mkdir(paths.sharedWorkspacesDir, { recursive: true });
    }
    await mark("move-workspaces");
  }
  if (!done.has("move-live")) {
    if (existsSync(live) && !isJunction(live)) {
      await fs.mkdir(paths.versionsDir, { recursive: true });
      if (existsSync(versionDir)) {
        throw new UpdaterError(
          `Version directory already exists while adopting: ${redact(versionDir)}`,
          { code: "VERSION_DIR_CONFLICT", exitCode: 15 },
        );
      }
      await fs.rename(live, versionDir);
    }
    await mark("move-live");
  }
  if (!done.has("junction-var")) {
    const newVar = path.join(versionDir, "apps", "agent-hub", "var");
    if (!existsSync(newVar)) createJunction(newVar, paths.sharedVarDir);
    await mark("junction-var");
  }
  if (!done.has("junction-workspaces")) {
    const newWorkspaces = path.join(versionDir, "apps", "agent-hub", "workspaces");
    if (!existsSync(newWorkspaces)) createJunction(newWorkspaces, paths.sharedWorkspacesDir);
    await mark("junction-workspaces");
  }
  if (!done.has("marker")) {
    await atomicWriteJson(path.join(versionDir, ".a446-version.json"), { version: key, adoptedAt: nowIso() });
    await mark("marker");
  }
  if (!done.has("current-junction")) {
    if (!isJunction(paths.currentJunction)) {
      if (existsSync(paths.currentJunction)) await fs.rm(paths.currentJunction, { force: true });
      createJunction(paths.currentJunction, versionDir);
    }
    await mark("current-junction");
  }
  if (!done.has("live-junction")) {
    if (!isJunction(live)) {
      if (existsSync(live)) await fs.rm(live, { force: true, recursive: true });
      createJunction(live, paths.currentJunction);
    }
    await mark("live-junction");
  }
  if (!done.has("current-json")) {
    await writeCurrentJson(root, { version: key, target: `versions/${key}` });
    await mark("current-json");
  }
  await fs.rm(journalFile, { force: true });
  log(`adopted ${redact(live)} -> version ${key}`);
  return { installRoot: root, livePath: live, version: key };
}

export async function unadoptLayout({ livePath, installRoot, journalFile, logger }) {
  const log = logger ?? (() => {});
  const live = path.resolve(livePath);
  const root = path.resolve(installRoot);
  const paths = layoutPaths(root);
  const current = await resolveCurrentTarget(root);
  if (!current) throw new UpdaterError(`No adopted layout found under ${redact(root)}`, { code: "NOT_ADOPTED", exitCode: 4 });
  const key = versionKey(current.version);
  const versionDir = path.join(paths.versionsDir, key);

  const journal = (await readJsonIfPresent(journalFile)) ?? { steps: [], livePath: live, installRoot: root, versionKey: key };
  const done = new Set(journal.steps);
  const mark = async (step) => {
    if (!done.has(step)) {
      journal.steps.push(step);
      await atomicWriteJson(journalFile, journal);
      done.add(step);
    }
  };

  if (!done.has("remove-live-junction")) {
    if (isJunction(live)) await removeJunction(live);
    else if (existsSync(live)) {
      throw new UpdaterError(`Live path is not a junction: ${redact(live)}`, { code: "NOT_A_JUNCTION", exitCode: 15 });
    }
    await mark("remove-live-junction");
  }
  if (!done.has("restore-live")) {
    if (!existsSync(live)) await fs.rename(versionDir, live);
    await mark("restore-live");
  }
  if (!done.has("restore-var")) {
    const varPath = path.join(live, "apps", "agent-hub", "var");
    if (existsSync(varPath)) await removeJunction(varPath);
    if (existsSync(paths.sharedVarDir)) await fs.rename(paths.sharedVarDir, varPath);
    await mark("restore-var");
  }
  if (!done.has("restore-workspaces")) {
    const workspacesPath = path.join(live, "apps", "agent-hub", "workspaces");
    if (existsSync(workspacesPath) && isJunction(workspacesPath)) await removeJunction(workspacesPath);
    if (existsSync(paths.sharedWorkspacesDir) && !existsSync(workspacesPath)) {
      await fs.rename(paths.sharedWorkspacesDir, workspacesPath);
    }
    await mark("restore-workspaces");
  }
  if (!done.has("cleanup")) {
    if (isJunction(paths.currentJunction)) await removeJunction(paths.currentJunction);
    await fs.rm(paths.currentJson, { force: true });
    await fs.rm(path.join(live, ".a446-version.json"), { force: true });
    await mark("cleanup");
  }
  await fs.rm(journalFile, { force: true });
  log(`unadopted ${redact(live)} (restored version ${key})`);
  return { livePath: live, restoredVersion: key };
}

/**
 * Switches installRoot/current junction from one version directory to another.
 * `live` must be a junction to installRoot/current and is never touched here,
 * so the live path has no disappearance window.
 *
 * Two-phase, provably-safe swap (docs/UPDATER_PROTOCOL.md 3.2):
 *   phase A: create `current.next` junction -> new version directory
 *            (a new object; nothing existing is modified)
 *   phase B: rename `current` -> `current.old`, then rename `current.next`
 *            -> `current`, then remove `current.old`.
 * The only window in which `current` does not exist sits between the two
 * renames of phase B (two consecutive rename syscalls). Every intermediate
 * state is unambiguous and repaired by re-invoking this function:
 *   - crash in phase A: `current` still points at the old version;
 *   - crash between the renames: `current` missing, `current.next` and
 *     `current.old` present -> the entry below completes the second rename;
 *   - crash after the second rename: `current` already points at the new
 *     version (idempotent entry removes the stale `current.old`).
 * After the swap the final junction target is re-read and must equal the
 * requested version directory, so success is only ever reported for a
 * physical fact that has already happened.
 */
export async function switchCurrentJunction(installRoot, version, { faultHook } = {}) {
  const paths = layoutPaths(installRoot);
  const versionDir = versionDirPath(installRoot, version);
  const stagedMarker = path.join(versionDir, INSTALL_LAYOUT.stagedMarker);
  const adoptedMarker = path.join(versionDir, ".a446-version.json");
  if (!existsSync(stagedMarker) && !existsSync(adoptedMarker)) {
    throw new UpdaterError(
      `Target version directory is neither fully staged nor an adopted version: ${redact(versionDir)}`,
      { code: "NOT_STAGED", exitCode: 15 },
    );
  }
  const current = paths.currentJunction;
  const next = `${current}.next`;
  const old = `${current}.old`;

  if (existsSync(current) && !isJunction(current)) {
    throw new UpdaterError(`installRoot/current is not a junction: ${redact(current)}`, { code: "NOT_A_JUNCTION", exitCode: 15 });
  }
  if (existsSync(old) && !isJunction(old)) {
    throw new UpdaterError(`installRoot/current.old is not a junction: ${redact(old)}`, { code: "NOT_A_JUNCTION", exitCode: 15 });
  }

  if (isJunction(current) && path.resolve(readJunctionTarget(current)) === path.resolve(versionDir)) {
    // Idempotent: the junction already points at the requested version.
    if (isJunction(old)) await removeJunction(old).catch(() => {});
    await writeCurrentJson(installRoot, { version, target: `versions/${versionKey(version)}` });
    return { switched: false, target: versionDir };
  }

  if (!existsSync(current)) {
    // A previous swap was interrupted between its two renames.
    if (isJunction(next) && isJunction(old)) {
      const nextTarget = path.resolve(readJunctionTarget(next));
      if (nextTarget === path.resolve(versionDir)) {
        // The pending link targets the requested version: complete the swap.
        await fs.rename(next, current);
      } else {
        // The pending link belongs to a different target (e.g. a rollback
        // interrupting an in-flight switch): restore the previous current.
        await fs.rename(old, current);
      }
      await removeJunction(next).catch(() => {});
      await removeJunction(old).catch(() => {});
    } else if (!isJunction(next)) {
      throw new UpdaterError(
        `installRoot/current is missing and no pending swap exists to recover from (${redact(current)}).`,
        { code: "STATE_CORRUPT", exitCode: 16 },
      );
    } else {
      // current missing, next present, old missing: not a state this
      // algorithm can produce; refuse to guess.
      throw new UpdaterError(
        `installRoot/current is missing with an unexplainable leftover link (${redact(next)}).`,
        { code: "STATE_CORRUPT", exitCode: 16 },
      );
    }
  } else {
    // Replace any leftovers from an earlier interrupted attempt.
    if (existsSync(next)) {
      if (!isJunction(next)) {
        throw new UpdaterError(`installRoot/current.next is not a junction: ${redact(next)}`, { code: "NOT_A_JUNCTION", exitCode: 15 });
      }
      await removeJunction(next);
    }
    if (isJunction(old)) await removeJunction(old).catch(() => {});
    // Phase A: stage the new link (does not modify anything existing).
    createJunction(next, versionDir);
    // Phase B: two consecutive renames - the only missing-current window.
    await fs.rename(current, old);
    faultHook?.("between-renames");
    await fs.rename(next, current);
    if (isJunction(old)) await removeJunction(old).catch(() => {});
  }

  // Verify the physical fact before reporting success.
  if (!isJunction(current)) {
    throw new UpdaterError(
      `Switching ${redact(current)} to ${redact(versionDir)} did not produce a junction.`,
      { code: "JUNCTION_SWITCH_FAILED", exitCode: 15 },
    );
  }
  const finalTarget = path.resolve(readJunctionTarget(current));
  if (finalTarget !== path.resolve(versionDir)) {
    throw new UpdaterError(
      `After switching, ${redact(current)} points at ${redact(finalTarget)} instead of ${redact(versionDir)}.`,
      { code: "JUNCTION_SWITCH_FAILED", exitCode: 15 },
    );
  }
  await writeCurrentJson(installRoot, { version, target: `versions/${versionKey(version)}` });
  return { switched: true, target: versionDir };
}
