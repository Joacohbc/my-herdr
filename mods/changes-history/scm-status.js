export const SCM_COLORS = {
  added: "#81b88b",
  modified: "#E2C08D",
  deleted: "#c74e39",
  renamed: "#73C991",
  untracked: "#73C991",
  ignored: "#8C8C8C",
  conflict: "#e4676b",
  submodule: "#8db9e2",
};

export const DIFF_COLORS = {
  addBg: "#1b5e3652",
  delBg: "#b8383d4c",
  addSign: "#3fb950",
  delSign: "#f16c67",
  rulerAdd: "#19874c",
  rulerDel: "#b8444b",
  rulerEdgeAdd: "#2ea043",
  rulerEdgeDel: "#f16c67",
  rulerTrack: "#111215",
  rulerViewport: "#ffffff24",
};

const SCM_COLOR_BY_STATUS = new Map([
  ["A", SCM_COLORS.added],
  ["U", SCM_COLORS.untracked],
  ["M", SCM_COLORS.modified],
  ["T", SCM_COLORS.modified],
  ["D", SCM_COLORS.deleted],
  ["R", SCM_COLORS.renamed],
  ["C", SCM_COLORS.renamed],
  ["!", SCM_COLORS.conflict],
]);

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const RENAME_OR_COPY_CODES = new Set(["R", "C"]);

const DEFAULT_STATUS_LIMIT = 1000;
const DEFAULT_NAME_STATUS_LIMIT = 400;
const NUL_SEPARATOR = "\0";
const XY_LENGTH = 2;
const STATUS_SEPARATOR_INDEX = 2;
const PATH_START_INDEX = 3;
const MIN_ENTRY_LENGTH = 4;
const NORMAL_TOKEN_COUNT = 1;
const RENAME_TOKEN_COUNT = 2;
const CONFLICT_BADGE_STATUS = "!";
const UNTRACKED_BADGE_STATUS = "U";
const UNTRACKED_PAIR = "??";
const UNMODIFIED_CODE = " ";
const UNTRACKED_CODE = "?";

export function scmColor(status) {
  return SCM_COLOR_BY_STATUS.get(status) ?? SCM_COLORS.modified;
}

export function parseStatusZ(stdout, limit = DEFAULT_STATUS_LIMIT) {
  const result = createEmptyStatusResult();
  if (!stdout || typeof stdout !== "string") return result;

  const tokens = stdout.split(NUL_SEPARATOR);
  const uniquePaths = new Set();
  let parsedRecords = 0;
  let tokenIndex = 0;

  while (tokenIndex < tokens.length) {
    const entry = tokens[tokenIndex];
    if (!isValidStatusEntry(entry)) {
      tokenIndex += NORMAL_TOKEN_COUNT;
      continue;
    }
    if (parsedRecords >= limit) {
      result.limited = true;
      break;
    }
    const consumedTokens = appendStatusEntry(entry, tokens[tokenIndex + 1], result, uniquePaths);
    parsedRecords += 1;
    tokenIndex += consumedTokens;
  }

  result.count = uniquePaths.size;
  return result;
}

function createEmptyStatusResult() {
  return { staged: [], unstaged: [], conflicts: [], limited: false, count: 0 };
}

function isValidStatusEntry(entry) {
  if (!entry || entry.length < MIN_ENTRY_LENGTH) return false;
  return entry[STATUS_SEPARATOR_INDEX] === UNMODIFIED_CODE;
}

function isRenameOrCopyStatus(indexStatus, worktreeStatus) {
  return RENAME_OR_COPY_CODES.has(indexStatus) || RENAME_OR_COPY_CODES.has(worktreeStatus);
}

function isActiveStatus(statusCode) {
  return statusCode !== UNMODIFIED_CODE && statusCode !== UNTRACKED_CODE;
}

function appendStatusEntry(entry, nextToken, result, uniquePaths) {
  const statusPair = entry.slice(0, XY_LENGTH);
  const indexStatus = entry[0];
  const worktreeStatus = entry[1];
  const filePath = entry.slice(PATH_START_INDEX);
  const isRenameOrCopy = isRenameOrCopyStatus(indexStatus, worktreeStatus);
  const origPath = isRenameOrCopy && nextToken ? nextToken : "";
  const consumedTokens = isRenameOrCopy ? RENAME_TOKEN_COUNT : NORMAL_TOKEN_COUNT;

  uniquePaths.add(filePath);

  if (CONFLICT_CODES.has(statusPair)) {
    result.conflicts.push({ path: filePath, status: CONFLICT_BADGE_STATUS, conflict: true, staged: false });
    return consumedTokens;
  }

  if (statusPair === UNTRACKED_PAIR) {
    result.unstaged.push({ path: filePath, status: UNTRACKED_BADGE_STATUS, untracked: true, staged: false });
    return consumedTokens;
  }

  appendStagedAndUnstaged(filePath, origPath, indexStatus, worktreeStatus, result);
  return consumedTokens;
}

export function parseNameStatusZ(stdout, limit = DEFAULT_NAME_STATUS_LIMIT) {
  if (!stdout || typeof stdout !== "string") return [];
  const files = [];
  const tokens = stdout.split(NUL_SEPARATOR);
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const rawStatus = tokens[index];
    if (!rawStatus) continue;
    const status = rawStatus[0];
    const isRenameOrCopy = RENAME_OR_COPY_CODES.has(status) && index + 2 < tokens.length;
    const origPath = isRenameOrCopy ? tokens[index + 1] : "";
    const filePath = isRenameOrCopy ? tokens[index + 2] : tokens[index + 1];
    if (isRenameOrCopy) index += 1;
    if (!filePath) continue;
    files.push({
      path: filePath,
      ...(origPath ? { origPath } : {}),
      status,
    });
    if (files.length >= limit) break;
  }
  return files;
}

function appendStagedAndUnstaged(filePath, origPath, indexStatus, worktreeStatus, result) {
  const origField = origPath ? { origPath } : {};
  if (isActiveStatus(indexStatus)) {
    result.staged.push({ path: filePath, ...origField, status: indexStatus, untracked: false, staged: true });
  }
  if (isActiveStatus(worktreeStatus)) {
    result.unstaged.push({ path: filePath, ...origField, status: worktreeStatus, untracked: false, staged: false });
  }
}
