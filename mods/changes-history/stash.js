import { parseNameStatusZ } from "./scm-status.js";

const GIT_READ_FLAGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_STASH_FILES = 400;
const GIT_TIMEOUT_MS = 8000;

const STASH_PUSH_BASE_BY_MODE = {
  all: ["stash", "push", "-u"],
  tracked: ["stash", "push"],
  staged: ["stash", "push", "--staged"],
};

function formatExecError(result, fallbackMessage) {
  return (result.stderr || result.stdout || fallbackMessage).trim();
}

function parseUntrackedPaths(lsTreeResult) {
  if (lsTreeResult.code !== 0) return new Set();
  const entries = (lsTreeResult.stdout || "").split("\0").filter(Boolean);
  return new Set(entries);
}

function mergeStashFiles(worktreeFiles, stagedFiles, untrackedPaths) {
  const merged = [];
  const seenPaths = new Set();
  for (const file of worktreeFiles) {
    const isUntracked = untrackedPaths.has(file.path);
    seenPaths.add(file.path);
    merged.push({
      ...file,
      status: isUntracked ? "U" : file.status,
      untracked: isUntracked,
    });
    if (merged.length >= MAX_STASH_FILES) return merged;
  }
  for (const file of stagedFiles) {
    if (seenPaths.has(file.path)) continue;
    seenPaths.add(file.path);
    merged.push({
      ...file,
      untracked: false,
      stagedOnly: true,
    });
    if (merged.length >= MAX_STASH_FILES) return merged;
  }
  return merged;
}

export function stashPushArgs({ mode = "all", message = "", paths = [] } = {}) {
  const baseArgs = STASH_PUSH_BASE_BY_MODE[mode];
  if (!baseArgs) {
    throw new Error(`Unsupported stash push mode: ${mode}`);
  }
  const args = [...baseArgs];
  const trimmedMessage = message ? message.trim() : "";
  if (trimmedMessage) {
    args.push("-m", trimmedMessage);
  }
  if (paths && paths.length) {
    args.push("--", ...paths);
  }
  return args;
}

export function stashApplyArgs(ref, { pop = false, keepIndex = false } = {}) {
  const action = pop ? "pop" : "apply";
  const indexFlags = keepIndex ? ["--index"] : [];
  return ["stash", action, ...indexFlags, ref];
}

export async function loadStashFiles(exec, { root, on, ref }) {
  const opts = { cwd: root, on, timeout: GIT_TIMEOUT_MS };
  const [stashShowResult, lsTreeResult, indexDiffResult] = await Promise.all([
    exec("git", [...GIT_READ_FLAGS, "stash", "show", "--name-status", "-z", "--include-untracked", ref], opts),
    exec("git", [...GIT_READ_FLAGS, "ls-tree", "-r", "--name-only", "-z", `${ref}^3`], opts).catch(() => ({ code: 1, stdout: "", stderr: "" })),
    exec("git", [...GIT_READ_FLAGS, "diff", "--name-status", "-z", `${ref}^1`, `${ref}^2`], opts).catch(() => ({ code: 1, stdout: "", stderr: "" })),
  ]);

  if (stashShowResult.code !== 0) {
    throw new Error(formatExecError(stashShowResult, "Failed to load stash files"));
  }

  const untrackedPaths = parseUntrackedPaths(lsTreeResult);
  const worktreeFiles = parseNameStatusZ(stashShowResult.stdout, MAX_STASH_FILES);
  const stagedFiles = indexDiffResult.code === 0 ? parseNameStatusZ(indexDiffResult.stdout, MAX_STASH_FILES) : [];
  return mergeStashFiles(worktreeFiles, stagedFiles, untrackedPaths);
}

export async function loadStashFileDiff(exec, { root, on, ref, path, untracked = false, stagedOnly = false, origPath = "" }) {
  const pathArgs = origPath ? [origPath, path] : [path];
  let gitArgs;
  if (untracked) {
    gitArgs = [...GIT_READ_FLAGS, "show", "--format=", "--no-ext-diff", "--no-textconv", "--no-color", `${ref}^3`, "--", path];
  } else {
    const targetRef = stagedOnly ? `${ref}^2` : ref;
    gitArgs = [...GIT_READ_FLAGS, "diff", "--no-ext-diff", "--no-textconv", "--no-color", `${ref}^1`, targetRef, "--", ...pathArgs];
  }

  const diffResult = await exec("git", gitArgs, {
    cwd: root,
    on,
    timeout: GIT_TIMEOUT_MS,
  });

  if (diffResult.code !== 0) {
    throw new Error(formatExecError(diffResult, "Failed to load stash file diff"));
  }

  return diffResult.stdout || "";
}
