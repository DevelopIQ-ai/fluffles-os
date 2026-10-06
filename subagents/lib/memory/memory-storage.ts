import fsp from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { assertSafeMemoryText } from "./memory-safety";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 60_000;

type LockOwner = { token: string; pid: number; processStartedAt: string; createdAt: string };
type LockHandle = { path: string; token: string };
type ReclaimOwner = { token: string; pid: number; processStartedAt: string; createdAt: string };
const RECLAIM_SUFFIX = ".reclaim";

export async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeAtomicText(filePath: string, value: string): Promise<void> {
  assertSafeMemoryText(value, filePath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tempPath, value.endsWith("\n") ? value : `${value}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(tempPath, filePath);
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function reclaimPath(lockPath: string): string {
  return `${lockPath}${RECLAIM_SUFFIX}`;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const stats = await fsp.stat(lockPath);
    const ownerPath = stats.isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
    const value = JSON.parse(await fsp.readFile(ownerPath, "utf8")) as Partial<LockOwner>;
    if (typeof value.token !== "string" || typeof value.pid !== "number" || typeof value.processStartedAt !== "string" || typeof value.createdAt !== "string") return null;
    return { token: value.token, pid: value.pid, processStartedAt: value.processStartedAt, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

function processStartedAt(pid: number): string | null {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function ownerIsAlive(owner: LockOwner): boolean {
  return processStartedAt(owner.pid) === owner.processStartedAt;
}

function ownerIsDead(owner: LockOwner | null): boolean {
  return owner != null && !ownerIsAlive(owner);
}

function sameOwner(left: LockOwner | null, right: LockOwner | null): boolean {
  return left?.token === right?.token
    && left?.pid === right?.pid
    && left?.processStartedAt === right?.processStartedAt;
}

async function removeReclaimMarker(markerPath: string, token: string): Promise<void> {
  try {
    const marker = JSON.parse(await fsp.readFile(markerPath, "utf8")) as Partial<ReclaimOwner>;
    if (marker.token === token) await fsp.rm(markerPath, { force: true });
  } catch {
    // A later reclaimer may have removed or replaced the marker.
  }
}

async function clearDeadReclaimMarker(markerPath: string): Promise<boolean> {
  const [stats, marker] = await Promise.all([fsp.stat(markerPath).catch(() => null), readLockOwner(markerPath)]);
  if (stats == null) return false;
  // A readable owner that is provably dead is reclaimable immediately; the
  // mtime grace window only protects a lock whose owner is not yet readable.
  if (Date.now() - stats.mtimeMs <= STALE_LOCK_MS && !ownerIsDead(marker)) return false;
  if (marker != null && ownerIsAlive(marker)) return false;
  await fsp.rm(markerPath, { force: true }).catch(() => undefined);
  return true;
}

async function waitForReclaimToFinish(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const markerPath = reclaimPath(lockPath);
  while (true) {
    try {
      await fsp.access(markerPath);
    } catch {
      return;
    }
    if (await clearDeadReclaimMarker(markerPath)) continue;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for stale lock reclamation: ${path.basename(lockPath)}`);
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

async function reclaimDeadLock(lockPath: string): Promise<void> {
  const [stats, owner] = await Promise.all([fsp.stat(lockPath).catch(() => null), readLockOwner(lockPath)]);
  if (stats == null) return;
  if (Date.now() - stats.mtimeMs <= STALE_LOCK_MS && !ownerIsDead(owner)) return;
  if (owner != null && ownerIsAlive(owner)) return;

  // The marker is outside the lock directory, so competing reclaimers cannot
  // recreate it while the elected reclaimer is deleting the stale directory.
  // Renaming then fences cleanup from new acquirers: they wait for the marker
  // to clear before creating a replacement lock at the live path.
  const markerPath = reclaimPath(lockPath);
  const startedAt = processStartedAt(process.pid);
  if (startedAt == null) return;
  const reclaimer: ReclaimOwner = {
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    pid: process.pid,
    processStartedAt: startedAt,
    createdAt: new Date().toISOString()
  };
  try {
    await fsp.writeFile(markerPath, `${JSON.stringify(reclaimer)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "EEXIST") {
      await clearDeadReclaimMarker(markerPath);
      return;
    }
    throw error;
  }

  const reclaimedPath = `${lockPath}.reclaiming.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    try {
      await fsp.rename(lockPath, reclaimedPath);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw error;
    }
    const confirmedOwner = await readLockOwner(reclaimedPath);
    if (!sameOwner(owner, confirmedOwner) || (confirmedOwner != null && ownerIsAlive(confirmedOwner))) {
      await fsp.rename(reclaimedPath, lockPath).catch(() => undefined);
      return;
    }
    await fsp.rm(reclaimedPath, { recursive: true, force: true });
  } finally {
    await removeReclaimMarker(markerPath, reclaimer.token);
  }
}

async function acquireLock(lockPath: string): Promise<LockHandle> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const startedAt = processStartedAt(process.pid);
  if (startedAt == null) throw new Error("could not determine memory lock owner identity");
  const owner: LockOwner = {
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    pid: process.pid,
    processStartedAt: startedAt,
    createdAt: new Date().toISOString()
  };
  while (true) {
    let created = false;
    try {
      await waitForReclaimToFinish(lockPath);
      const lockFile = await fsp.open(lockPath, "wx", 0o600);
      created = true;
      try {
        await lockFile.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      } finally {
        await lockFile.close();
      }
      return { path: lockPath, token: owner.token };
    } catch (error: unknown) {
      if (created) {
        await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      await reclaimDeadLock(lockPath);
      if (Date.now() >= deadline) throw new Error(`timed out waiting for memory write lock: ${path.basename(lockPath)}`);
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function releaseLock(lock: LockHandle): Promise<void> {
  const owner = await readLockOwner(lock.path);
  if (owner?.token !== lock.token) return;
  const confirmedOwner = await readLockOwner(lock.path);
  if (confirmedOwner?.token !== lock.token) return;
  await fsp.rm(lock.path, { force: true });
}

export async function withFileLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lock = await acquireLock(lockPath);
  try {
    return await action();
  } finally {
    await releaseLock(lock);
  }
}
