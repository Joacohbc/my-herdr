import { exec } from "herdr";

export const MAX_PRS = 50;
export const MAX_PR_FILES = 400;

const VALID_PR_STATES = new Set(["open", "merged", "closed", "all"]);
const PR_LIST_FIELDS = "number,title,state,isDraft,author,createdAt,updatedAt,headRefName,baseRefName,url,additions,deletions,changedFiles";
const PR_VIEW_FIELDS = `${PR_LIST_FIELDS},files,reviewDecision`;

export function formatIsoDate(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : "";
}

export function buildRemoteBranchUrl(remoteUrl, branchName) {
  const raw = String(remoteUrl || "").trim();
  const branch = String(branchName || "").trim();
  if (!raw || !branch || branch === "HEAD") return null;

  let host = "";
  let repoPath = "";
  const scpMatch = /^(?:[^@]+@)?([^:\/]+):(.+)$/.exec(raw);
  const urlMatch = /^(?:https?|ssh):\/\/(?:[^@\/]+@)?([^\/]+)\/(.+)$/.exec(raw);

  if (urlMatch) {
    host = urlMatch[1];
    repoPath = urlMatch[2];
  } else if (scpMatch) {
    host = scpMatch[1];
    repoPath = scpMatch[2];
  } else {
    return null;
  }

  repoPath = repoPath.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !repoPath) return null;

  const baseUrl = `https://${host}/${repoPath}`;
  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  const lowerHost = host.toLowerCase();
  if (lowerHost.includes("bitbucket.org")) {
    return `${baseUrl}/src/${encodedBranch}`;
  }
  if (lowerHost.includes("gitlab")) {
    return `${baseUrl}/-/tree/${encodedBranch}`;
  }
  return `${baseUrl}/tree/${encodedBranch}`;
}

function classifyGhError(raw) {
  const text = String(raw || "").trim();
  const lower = text.toLowerCase();
  if (!text) return "GitHub CLI command failed";
  if (lower.includes("enoent") || lower.includes("not found") || lower.includes("no such file")) {
    return "GitHub CLI (gh) is not installed";
  }
  if (
    lower.includes("no git remotes")
    || lower.includes("none of the git remotes")
    || lower.includes("could not resolve to a repository")
    || lower.includes("not a github repository")
  ) {
    return "No GitHub remote detected";
  }
  if (lower.includes("gh auth login") || lower.includes("authentication") || lower.includes("401")) {
    return "GitHub auth required (run: gh auth login)";
  }
  return text.split("\n")[0].slice(0, 160);
}

function normalizePr(raw) {
  return {
    number: Number(raw?.number) || 0,
    title: String(raw?.title || "(untitled)"),
    state: String(raw?.state || "OPEN").toUpperCase(),
    isDraft: Boolean(raw?.isDraft),
    author: String(raw?.author?.login || raw?.author?.name || "unknown"),
    createdDate: formatIsoDate(raw?.createdAt),
    updatedDate: formatIsoDate(raw?.updatedAt),
    headRefName: String(raw?.headRefName || ""),
    baseRefName: String(raw?.baseRefName || ""),
    url: String(raw?.url || ""),
    additions: Number(raw?.additions) || 0,
    deletions: Number(raw?.deletions) || 0,
    changedFiles: Number(raw?.changedFiles) || 0,
    reviewDecision: String(raw?.reviewDecision || ""),
  };
}

function extractDiffPath(headerLine) {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(headerLine);
  return match ? match[2] : null;
}

export function parseUnifiedDiffByFile(stdout, maxDiffLines, maxLineChars) {
  const map = new Map();
  if (!stdout) return map;

  let currentPath = null;
  let currentLines = [];
  let inHunk = false;

  const flush = () => {
    if (!currentPath) return;
    if (map.size >= MAX_PR_FILES) return;
    map.set(
      currentPath,
      currentLines.length ? currentLines : ["Binary file or empty diff"],
    );
  };

  for (const rawLine of stdout.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      flush();
      currentPath = extractDiffPath(rawLine);
      currentLines = [];
      inHunk = false;
      continue;
    }
    if (!currentPath) continue;
    if (!inHunk) {
      if (rawLine.startsWith("+++ b/")) {
        currentPath = rawLine.slice(6);
        continue;
      }
      if (rawLine.startsWith("--- a/") && currentPath === "/dev/null") {
        currentPath = rawLine.slice(6);
        continue;
      }
      if (rawLine.startsWith("@@")) {
        inHunk = true;
      } else {
        continue;
      }
    }
    if (currentLines.length < maxDiffLines) {
      currentLines.push(rawLine.length > maxLineChars ? rawLine.slice(0, maxLineChars) + "…" : rawLine);
    }
  }
  flush();
  return map;
}

export async function listPullRequests(root, on, { state = "open", query = "", limit = 30 } = {}) {
  const safeState = VALID_PR_STATES.has(state) ? state : "open";
  const cappedLimit = Math.max(1, Math.min(MAX_PRS, Number(limit) || 30));
  const args = [
    "pr",
    "list",
    "--state",
    safeState,
    "--limit",
    String(cappedLimit),
    "--json",
    PR_LIST_FIELDS,
  ];
  const trimmed = String(query || "").trim();
  if (trimmed) {
    args.push("--search", trimmed);
  }
  try {
    const res = await exec("gh", args, { cwd: root, on, timeout: 12000 });
    if (res.code !== 0) {
      return { ok: false, error: classifyGhError(res.stderr || res.stdout), prs: [] };
    }
    const parsed = JSON.parse(res.stdout || "[]");
    const prs = Array.isArray(parsed) ? parsed.slice(0, MAX_PRS).map(normalizePr) : [];
    return { ok: true, error: null, prs };
  } catch (err) {
    return { ok: false, error: classifyGhError(err?.message || err), prs: [] };
  }
}

export async function loadPullRequestDetail(root, on, prNumber, maxDiffLines = 1000, maxLineChars = 2000) {
  const numStr = String(Number(prNumber) || 0);
  if (numStr === "0") {
    return { ok: false, error: "Invalid pull request number", pr: null, files: [], diffByFile: new Map() };
  }
  try {
    const [viewRes, diffRes] = await Promise.all([
      exec("gh", ["pr", "view", numStr, "--json", PR_VIEW_FIELDS], { cwd: root, on, timeout: 12000 }),
      exec("gh", ["pr", "diff", numStr, "--color=never"], { cwd: root, on, timeout: 15000 }),
    ]);
    if (viewRes.code !== 0) {
      return {
        ok: false,
        error: classifyGhError(viewRes.stderr || viewRes.stdout),
        pr: null,
        files: [],
        diffByFile: new Map(),
      };
    }
    const raw = JSON.parse(viewRes.stdout || "{}");
    const pr = normalizePr(raw);
    const files = Array.isArray(raw?.files)
      ? raw.files.slice(0, MAX_PR_FILES).map(f => ({
          path: String(f?.path || ""),
          add: Number(f?.additions) || 0,
          del: Number(f?.deletions) || 0,
          status: f?.additions > 0 && f?.deletions === 0 ? "A" : f?.deletions > 0 && f?.additions === 0 ? "D" : "M",
        })).filter(f => f.path)
      : [];
    const diffByFile = diffRes.code === 0
      ? parseUnifiedDiffByFile(diffRes.stdout || "", maxDiffLines, maxLineChars)
      : new Map();
    return { ok: true, error: null, pr, files, diffByFile };
  } catch (err) {
    return { ok: false, error: classifyGhError(err?.message || err), pr: null, files: [], diffByFile: new Map() };
  }
}

export async function checkoutPullRequest(root, on, prNumber) {
  const numStr = String(Number(prNumber) || 0);
  if (numStr === "0") return { ok: false, error: "Invalid pull request number" };
  try {
    const res = await exec("gh", ["pr", "checkout", numStr], { cwd: root, on, timeout: 20000 });
    if (res.code !== 0) {
      return { ok: false, error: classifyGhError(res.stderr || res.stdout) };
    }
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: classifyGhError(err?.message || err) };
  }
}
