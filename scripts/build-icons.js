#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const currentFilesIconsPath = join(repoDir, "mods", "files-search", "material-icons.js");
const changesIconsPath = join(repoDir, "mods", "changes-history", "material-icons.js");

const rawSource = readFileSync(currentFilesIconsPath, "utf8");

function extractJsonMap(source, constName) {
  const match = new RegExp(`const ${constName} = (\\{.*?\\});`, "s").exec(source);
  if (!match) throw new Error(`Missing ${constName}`);
  return JSON.parse(match[1]);
}

const fileNames = extractJsonMap(rawSource, "FILE_NAMES");
const fileExts = extractJsonMap(rawSource, "FILE_EXTS");
const folderNames = extractJsonMap(rawSource, "FOLDER_NAMES");

function packInvertedMap(recordMap, stripPrefix = "") {
  const grouped = new Map();
  for (const [key, svgFile] of Object.entries(recordMap)) {
    let stem = svgFile.endsWith(".svg") ? svgFile.slice(0, -4) : svgFile;
    if (stripPrefix && stem.startsWith(stripPrefix)) {
      stem = "~" + stem.slice(stripPrefix.length);
    }
    if (!grouped.has(stem)) grouped.set(stem, []);
    grouped.get(stem).push(key);
  }
  const lines = [];
  for (const [stem, keys] of grouped.entries()) {
    lines.push(`${stem}:${keys.join(",")}`);
  }
  return lines.join("\n");
}

function unwrapFolderKey(key) {
  if (key.startsWith("__") && key.endsWith("__") && key.length > 4) return key.slice(2, -2);
  if ((key.startsWith(".") || key.startsWith("_") || key.startsWith("-")) && key.length > 1) return key.slice(1);
  return key;
}

const compactFolders = {};
for (const [key, val] of Object.entries(folderNames)) {
  const base = unwrapFolderKey(key);
  if (base !== key && folderNames[base] === val) continue;
  compactFolders[key] = val;
}

const packedFiles = packInvertedMap(fileNames);
const packedExts = packInvertedMap(fileExts);
const packedFolders = packInvertedMap(compactFolders, "folder-");

function renderModule({ includeFolders }) {
  return `const BASE = "mods/files-search/micons/";
const DEFAULT_FILE = "file.svg";
${includeFolders ? 'const DEFAULT_FOLDER = "folder.svg";\nconst DEFAULT_FOLDER_OPEN = "folder-open.svg";\n' : ""}const MAX_LOOKUP_CACHE = 256;

const PACKED_FILE_NAMES = ${JSON.stringify(packedFiles)};
const PACKED_FILE_EXTS = ${JSON.stringify(packedExts)};
${includeFolders ? `const PACKED_FOLDERS = ${JSON.stringify(packedFolders)};\n` : ""}
let fileNameMap = null;
let fileExtMap = null;
${includeFolders ? "let folderNameMap = null;\n" : ""}const lookupCache = new Map();

function unpackTable(packed, prefix = "") {
  const table = new Map();
  for (const row of packed.split("\\n")) {
    const colon = row.indexOf(":");
    if (colon === -1) continue;
    const rawStem = row.slice(0, colon);
    const stem = (prefix && rawStem.startsWith("~") ? prefix + rawStem.slice(1) : rawStem) + ".svg";
    for (const key of row.slice(colon + 1).split(",")) {
      if (key) table.set(key, stem);
    }
  }
  return table;
}

function rememberLookup(cacheKey, value) {
  if (lookupCache.size >= MAX_LOOKUP_CACHE) {
    const oldestKey = lookupCache.keys().next().value;
    lookupCache.delete(oldestKey);
  }
  lookupCache.set(cacheKey, value);
  return value;
}

export function releaseIconCache() {
  fileNameMap = null;
  fileExtMap = null;
${includeFolders ? "  folderNameMap = null;\n" : ""}  lookupCache.clear();
}

export function fileIcon(name) {
  const lower = (name || "").toLowerCase();
  const cacheKey = "f:" + lower;
  const cached = lookupCache.get(cacheKey);
  if (cached) return cached;

  if (!fileNameMap) fileNameMap = unpackTable(PACKED_FILE_NAMES);
  const exact = fileNameMap.get(lower);
  if (exact) return rememberLookup(cacheKey, BASE + exact);

  if (!fileExtMap) fileExtMap = unpackTable(PACKED_FILE_EXTS);
  let dotIndex = lower.indexOf(".");
  while (dotIndex !== -1 && dotIndex + 1 < lower.length) {
    const extMatch = fileExtMap.get(lower.slice(dotIndex + 1));
    if (extMatch) return rememberLookup(cacheKey, BASE + extMatch);
    dotIndex = lower.indexOf(".", dotIndex + 1);
  }
  return rememberLookup(cacheKey, BASE + DEFAULT_FILE);
}
${includeFolders ? `
function normalizeFolderKey(lower) {
  if (lower.startsWith("__") && lower.endsWith("__") && lower.length > 4) return lower.slice(2, -2);
  if ((lower.startsWith(".") || lower.startsWith("_") || lower.startsWith("-")) && lower.length > 1) return lower.slice(1);
  return lower;
}

function toOpenFolderSvg(closedSvg) {
  if (closedSvg.endsWith(".clone.svg")) {
    return closedSvg.slice(0, -10) + "-open.clone.svg";
  }
  return closedSvg.slice(0, -4) + "-open.svg";
}

export function folderIcon(name, isOpen) {
  const lower = (name || "").toLowerCase();
  const cacheKey = (isOpen ? "o:" : "c:") + lower;
  const cached = lookupCache.get(cacheKey);
  if (cached) return cached;

  if (!folderNameMap) folderNameMap = unpackTable(PACKED_FOLDERS, "folder-");
  const closedSvg = folderNameMap.get(lower) || folderNameMap.get(normalizeFolderKey(lower));
  if (!closedSvg) {
    return rememberLookup(cacheKey, BASE + (isOpen ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER));
  }
  return rememberLookup(cacheKey, BASE + (isOpen ? toOpenFolderSvg(closedSvg) : closedSvg));
}
` : ""}`;
}

writeFileSync(currentFilesIconsPath, renderModule({ includeFolders: true }), "utf8");
writeFileSync(changesIconsPath, renderModule({ includeFolders: false }), "utf8");
console.log("Generated compact material-icons.js modules");
