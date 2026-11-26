export const MAX_PATCH_BYTES = 100_000;
export const MAX_PATCH_CHARS = MAX_PATCH_BYTES;

export const APPLY_FLAGS = {
  stage: ["--cached"],
  unstage: ["--cached", "-R"],
  revert: ["-R"]
};

const DEFAULT_HUNK_LINE_COUNT = 1;
const APPLY_TIMEOUT_MS = 15_000;
const APPLY_STDIN_PREFIX = 'printf "%s" "$1" | git apply --whitespace=nowarn ';
const APPLY_SCRIPT_ARG0 = "herdr-apply";
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function utf8ByteLength(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function splitDiffLines(stdout) {
  if (!stdout) return [];
  const withoutTrailingNewline = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!withoutTrailingNewline) return [];
  return withoutTrailingNewline.split("\n");
}

function parseHunkHeader(line) {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? DEFAULT_HUNK_LINE_COUNT : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? DEFAULT_HUNK_LINE_COUNT : Number(match[4])
  };
}

function finalizeHunk(hunks, hunk, endIndex) {
  if (!hunk) return;
  hunk.bodyEnd = endIndex;
  hunks.push(hunk);
}

function collectHunks(bodyLines) {
  const hunks = [];
  let currentHunk = null;
  for (let index = 0; index < bodyLines.length; index++) {
    const line = bodyLines[index];
    const parsedHeader = parseHunkHeader(line);
    if (parsedHeader) {
      finalizeHunk(hunks, currentHunk, index);
      currentHunk = {
        ...parsedHeader,
        header: line,
        lines: [],
        bodyStart: index,
        bodyEnd: index + 1
      };
      continue;
    }
    if (currentHunk) currentHunk.lines.push(line);
  }
  finalizeHunk(hunks, currentHunk, bodyLines.length);
  return hunks;
}

function isBinaryHeader(headerLines) {
  return headerLines.some(line => line.startsWith("Binary files ") || line === "GIT binary patch");
}

export function splitDiff(stdout) {
  const allLines = splitDiffLines(stdout);
  const diffHeaderIndex = allLines.findIndex(line => line.startsWith("diff --git"));
  const headerStartIndex = diffHeaderIndex >= 0 ? diffHeaderIndex : 0;
  const firstHunkIndex = allLines.findIndex(
    (line, index) => index >= headerStartIndex && HUNK_HEADER_PATTERN.test(line)
  );
  if (firstHunkIndex < 0) {
    return {
      header: allLines.slice(headerStartIndex),
      hunks: [],
      binary: true
    };
  }
  const header = allLines.slice(headerStartIndex, firstHunkIndex);
  const hunks = collectHunks(allLines.slice(firstHunkIndex));
  return {
    header,
    hunks,
    binary: isBinaryHeader(header) || hunks.length === 0
  };
}

export function buildHunkPatch(header, hunk) {
  const patch = [...header, hunk.header, ...hunk.lines].join("\n");
  return patch.endsWith("\n") ? patch : `${patch}\n`;
}

export async function applyHunk(exec, { root, on, patch, mode }) {
  const flags = Object.hasOwn(APPLY_FLAGS, mode) ? APPLY_FLAGS[mode] : null;
  if (!flags) return { ok: false, error: "Invalid hunk action" };
  if (!patch) return { ok: false, error: "Empty patch" };
  if (utf8ByteLength(patch) > MAX_PATCH_BYTES) {
    return { ok: false, error: "Hunk too large — use file-level actions" };
  }
  const script = `${APPLY_STDIN_PREFIX}${flags.join(" ")} -`;
  const applyResult = await exec(
    "sh",
    ["-c", script, APPLY_SCRIPT_ARG0, patch],
    { cwd: root, on, timeout: APPLY_TIMEOUT_MS }
  );
  const isSuccess = applyResult.code === 0;
  if (isSuccess) return { ok: true, error: null };
  const errorMessage = (applyResult.stderr || applyResult.stdout || "git apply failed").trim();
  return { ok: false, error: errorMessage };
}
