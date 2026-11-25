import { exec } from "herdr";

export const DEFAULT_EXCLUDED_DIRS = [
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "vendor",
  "coverage",
  ".nyc_output",
  ".gradle",
  ".idea",
  ".vscode",
  "bower_components",
  "Pods",
  ".dart_tool",
  ".zig-cache",
  "zig-out",
  "bin",
  "obj",
  ".terraform",
  ".serverless",
];

export const DEFAULT_EXCLUDED_FILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "*.min.js",
  "*.min.css",
  "*.map",
];

export const MAX_MATCHES = 300;
export const MAX_FILE_RESULTS = 200;
const SEARCH_TIMEOUT_MS = 8000;

export function parseGlobList(raw) {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher({ query, caseSensitive, wholeWord, regex }) {
  const flags = caseSensitive ? "" : "i";
  if (regex) {
    try {
      const source = wholeWord ? `\\b(?:${query})\\b` : query;
      return new RegExp(source, flags);
    } catch {
      return null;
    }
  }
  const escaped = escapeRegExp(query);
  const source = wholeWord ? `\\b${escaped}\\b` : escaped;
  return new RegExp(source, flags);
}

export function splitMatchHighlight(line, opts) {
  const trimmedStart = line.length - line.trimStart().length;
  const display = line.trim();
  if (!display) return { before: "", match: "", after: "", colOffset: trimmedStart };

  const matcher = buildMatcher(opts);
  if (!matcher) return { before: display, match: "", after: "", colOffset: trimmedStart };

  const m = matcher.exec(display);
  if (!m || !m[0].length) {
    return { before: display, match: "", after: "", colOffset: trimmedStart };
  }

  const maxContext = 140;
  let start = m.index;
  let end = m.index + m[0].length;
  let before = display.slice(0, start);
  const match = display.slice(start, end);
  let after = display.slice(end);

  if (before.length > 36) {
    before = "…" + before.slice(before.length - 35);
  }
  const remaining = Math.max(24, maxContext - before.length - match.length);
  if (after.length > remaining) {
    after = after.slice(0, remaining) + "…";
  }
  return { before, match, after, colOffset: trimmedStart };
}

function buildUnixContentScript() {
  return `
query="$1"
case_sensitive="$2"
whole_word="$3"
use_regex="$4"
use_defaults="$5"
include_csv="$6"
exclude_csv="$7"
limit="$8"

split_csv() {
  old_ifs="$IFS"
  IFS=','
  for item in $1; do
    [ -n "$item" ] && printf '%s\\n' "$item"
  done
  IFS="$old_ifs"
}

if command -v rg >/dev/null 2>&1; then
  printf '__COLS__\\n'
  set -- --no-heading --with-filename --line-number --column --color=never --max-filesize=1M --max-columns=300 --max-columns-preview
  [ "$case_sensitive" = "1" ] || set -- "$@" -i
  [ "$whole_word" = "1" ] && set -- "$@" -w
  [ "$use_regex" = "1" ] || set -- "$@" -F
  if [ "$use_defaults" = "1" ]; then
    for d in ${DEFAULT_EXCLUDED_DIRS.join(" ")}; do
      set -- "$@" --glob "!\${d}/**" --glob "!\${d}"
    done
    for f in ${DEFAULT_EXCLUDED_FILES.map((f) => `'${f}'`).join(" ")}; do
      set -- "$@" --glob "!\${f}"
    done
  else
    set -- "$@" --no-ignore --hidden
  fi
  if [ -n "$include_csv" ]; then
    old_ifs="$IFS"; IFS=','
    for g in $include_csv; do [ -n "$g" ] && set -- "$@" --glob "$g"; done
    IFS="$old_ifs"
  fi
  if [ -n "$exclude_csv" ]; then
    old_ifs="$IFS"; IFS=','
    for g in $exclude_csv; do [ -n "$g" ] && set -- "$@" --glob "!\${g}" --glob "!\${g}/**"; done
    IFS="$old_ifs"
  fi
  rg "$@" -- "$query" . 2>/dev/null | head -n "$limit"
  exit 0
fi

if [ "$use_defaults" = "1" ] && command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '__COLS__\\n'
  set -- --no-optional-locks grep -I -n --column --no-color --untracked
  [ "$case_sensitive" = "1" ] || set -- "$@" -i
  [ "$whole_word" = "1" ] && set -- "$@" -w
  if [ "$use_regex" = "1" ]; then set -- "$@" -E; else set -- "$@" -F; fi
  set -- "$@" -e "$query" --
  if [ -n "$include_csv" ]; then
    old_ifs="$IFS"; IFS=','
    for g in $include_csv; do [ -n "$g" ] && set -- "$@" "$g"; done
    IFS="$old_ifs"
  else
    set -- "$@" .
  fi
  for d in ${DEFAULT_EXCLUDED_DIRS.join(" ")}; do
    set -- "$@" ":(exclude)\${d}" ":(exclude)*/\${d}"
  done
  for f in ${DEFAULT_EXCLUDED_FILES.map((f) => `'${f}'`).join(" ")}; do
    set -- "$@" ":(exclude)\${f}" ":(exclude)*/\${f}"
  done
  if [ -n "$exclude_csv" ]; then
    old_ifs="$IFS"; IFS=','
    for g in $exclude_csv; do [ -n "$g" ] && set -- "$@" ":(exclude)\${g}" ":(exclude)*/\${g}"; done
    IFS="$old_ifs"
  fi
  git "$@" 2>/dev/null | head -n "$limit"
  exit 0
fi

printf '__NOCOLS__\\n'
set -- -r -n -I --color=never
[ "$case_sensitive" = "1" ] || set -- "$@" -i
[ "$whole_word" = "1" ] && set -- "$@" -w
if [ "$use_regex" = "1" ]; then set -- "$@" -E; else set -- "$@" -F; fi
if [ "$use_defaults" = "1" ]; then
  for d in ${DEFAULT_EXCLUDED_DIRS.join(" ")}; do
    set -- "$@" "--exclude-dir=\${d}"
  done
  for f in ${DEFAULT_EXCLUDED_FILES.map((f) => `'${f}'`).join(" ")}; do
    set -- "$@" "--exclude=\${f}"
  done
fi
if [ -n "$include_csv" ]; then
  old_ifs="$IFS"; IFS=','
  for g in $include_csv; do [ -n "$g" ] && set -- "$@" "--include=\${g}"; done
  IFS="$old_ifs"
fi
if [ -n "$exclude_csv" ]; then
  old_ifs="$IFS"; IFS=','
  for g in $exclude_csv; do [ -n "$g" ] && set -- "$@" "--exclude-dir=\${g}" "--exclude=\${g}"; done
  IFS="$old_ifs"
fi
grep "$@" -- "$query" . 2>/dev/null | head -n "$limit"
exit 0
`;
}

function buildUnixFilesScript() {
  const pruneExpr = DEFAULT_EXCLUDED_DIRS.map((d) => `-name '${d}'`).join(" -o ");
  return `
use_defaults="$1"
limit="$2"

if command -v fd >/dev/null 2>&1; then
  set -- --type f --color never
  if [ "$use_defaults" = "1" ]; then
    for d in ${DEFAULT_EXCLUDED_DIRS.join(" ")}; do
      set -- "$@" -E "$d"
    done
  else
    set -- "$@" --no-ignore --hidden
  fi
  fd "$@" 2>/dev/null | head -n "$limit"
  exit 0
fi

if [ "$use_defaults" = "1" ] && command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git --no-optional-locks ls-files --cached --others --exclude-standard 2>/dev/null | head -n "$limit"
  exit 0
fi

if [ "$use_defaults" = "1" ]; then
  find . \\( ${pruneExpr} \\) -prune -o -type f -print 2>/dev/null | sed 's|^\\./||' | head -n "$limit"
else
  find . -name .git -prune -o -type f -print 2>/dev/null | sed 's|^\\./||' | head -n "$limit"
fi
exit 0
`;
}

function parseContentOutput(stdout, opts) {
  const rawLines = stdout.split(/\r?\n/);
  const modeHeader = rawLines[0];
  const hasCols = modeHeader === "__COLS__";
  const startIdx = modeHeader === "__COLS__" || modeHeader === "__NOCOLS__" ? 1 : 0;

  const groups = new Map();
  let totalMatches = 0;

  for (let i = startIdx; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (!raw) continue;

    let path, lineNum, colNum, text;
    if (hasCols) {
      const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(raw);
      if (!m) continue;
      path = m[1].replace(/^\.\//, "");
      lineNum = Number(m[2]);
      colNum = Number(m[3]);
      text = m[4];
    } else {
      const m = /^(.+?):(\d+):(.*)$/.exec(raw);
      if (!m) continue;
      path = m[1].replace(/^\.\//, "");
      lineNum = Number(m[2]);
      colNum = 1;
      text = m[3];
    }

    if (!path || !Number.isFinite(lineNum)) continue;
    totalMatches++;
    if (totalMatches > MAX_MATCHES) break;

    let group = groups.get(path);
    if (!group) {
      const slash = path.lastIndexOf("/");
      group = {
        path,
        name: slash >= 0 ? path.slice(slash + 1) : path,
        dir: slash >= 0 ? path.slice(0, slash) : "",
        matches: [],
      };
      groups.set(path, group);
    }

    const highlight = splitMatchHighlight(text, opts);
    group.matches.push({
      line: lineNum,
      col: colNum,
      text,
      before: highlight.before,
      match: highlight.match,
      after: highlight.after,
    });
  }

  return {
    groups: [...groups.values()],
    totalMatches: Math.min(totalMatches, MAX_MATCHES),
    limited: totalMatches > MAX_MATCHES,
  };
}

export async function searchContent(root, on, opts) {
  const query = opts.query ?? "";
  if (!query) return { groups: [], totalMatches: 0, limited: false };

  if (opts.regex) {
    try {
      new RegExp(query);
    } catch (e) {
      throw new Error(`Invalid regex: ${e.message}`);
    }
  }

  const includeCsv = parseGlobList(opts.include).join(",");
  const excludeCsv = parseGlobList(opts.exclude).join(",");

  const script = buildUnixContentScript();
  const r = await exec(
    "sh",
    [
      "-c",
      script,
      "herdr-search",
      query,
      opts.caseSensitive ? "1" : "0",
      opts.wholeWord ? "1" : "0",
      opts.regex ? "1" : "0",
      opts.useDefaultExcludes ? "1" : "0",
      includeCsv,
      excludeCsv,
      String(MAX_MATCHES + 1),
    ],
    { cwd: root, on, timeout: SEARCH_TIMEOUT_MS },
  );

  if (r.code !== 0 && !r.stdout) {
    throw new Error(r.stderr || "Search failed");
  }

  return parseContentOutput(r.stdout || "", opts);
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`(^|/)${escaped}($|/)`, "i");
}

function matchesGlobFilters(path, includeGlobs, excludeGlobs) {
  if (includeGlobs.length && !includeGlobs.some((re) => re.test(path))) return false;
  if (excludeGlobs.length && excludeGlobs.some((re) => re.test(path))) return false;
  return true;
}

function scoreFilePath(path, needle, caseSensitive) {
  const hay = caseSensitive ? path : path.toLowerCase();
  const q = caseSensitive ? needle : needle.toLowerCase();
  const slash = hay.lastIndexOf("/");
  const name = slash >= 0 ? hay.slice(slash + 1) : hay;

  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (hay.includes(q)) return 40;

  // Subsequence fuzzy match on filename or full path
  let qi = 0;
  for (let i = 0; i < hay.length && qi < q.length; i++) {
    if (hay[i] === q[qi]) qi++;
  }
  return qi === q.length ? 20 : 0;
}

export async function searchFiles(root, on, opts) {
  const query = (opts.query ?? "").trim();
  if (!query) return { files: [], limited: false };

  const script = buildUnixFilesScript();
  const r = await exec(
    "sh",
    ["-c", script, "herdr-files", opts.useDefaultExcludes ? "1" : "0", "12000"],
    { cwd: root, on, timeout: SEARCH_TIMEOUT_MS },
  );

  if (r.code !== 0 && !r.stdout) {
    throw new Error(r.stderr || "File search failed");
  }

  const defaultDirSet = new Set(DEFAULT_EXCLUDED_DIRS);
  const includeGlobs = parseGlobList(opts.include).map(globToRegex);
  const excludeGlobs = parseGlobList(opts.exclude).map(globToRegex);
  const regexMatcher = opts.regex ? buildMatcher(opts) : null;

  const scored = [];
  for (const raw of (r.stdout || "").split(/\r?\n/)) {
    const path = raw.replace(/^\.\//, "");
    if (!path) continue;

    if (opts.useDefaultExcludes) {
      const parts = path.split("/");
      if (parts.some((p) => defaultDirSet.has(p))) continue;
    }

    if (!matchesGlobFilters(path, includeGlobs, excludeGlobs)) continue;

    let score = 0;
    if (regexMatcher) {
      score = regexMatcher.test(path) ? 50 : 0;
    } else {
      score = scoreFilePath(path, query, opts.caseSensitive);
    }

    if (score > 0) {
      const slash = path.lastIndexOf("/");
      scored.push({
        path,
        name: slash >= 0 ? path.slice(slash + 1) : path,
        dir: slash >= 0 ? path.slice(0, slash) : "",
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  const limited = scored.length > MAX_FILE_RESULTS;
  return { files: scored.slice(0, MAX_FILE_RESULTS), limited };
}

export function offsetForLineCol(text, line, col, matchLen) {
  let currentLine = 1;
  let lineStart = 0;
  while (currentLine < line && lineStart < text.length) {
    const nl = text.indexOf("\n", lineStart);
    if (nl === -1) break;
    lineStart = nl + 1;
    currentLine++;
  }
  const nextNl = text.indexOf("\n", lineStart);
  const lineEnd = nextNl === -1 ? text.length : nextNl;
  const start = Math.min(lineEnd, lineStart + Math.max(0, (col || 1) - 1));
  const end = Math.min(lineEnd, start + Math.max(0, matchLen || 0));
  return { start, end };
}
