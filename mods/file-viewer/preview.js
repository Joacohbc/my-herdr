import { appHome, exec } from "herdr";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "svg", "avif"]);
const CSV_EXTS = new Set(["csv", "tsv"]);
const MD_EXTS = new Set(["md", "markdown", "mdx"]);

export const MAX_CSV_ROWS = 5000;
export const MAX_CSV_COLS = 60;

export function getExtension(path) {
  if (!path || !path.includes(".")) return "";
  return path.split(".").pop().toLowerCase();
}

export function detectFileKind(path) {
  const ext = getExtension(path);
  if (MD_EXTS.has(ext)) return "markdown";
  if (CSV_EXTS.has(ext)) return "csv";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return ext === "svg" ? "svg" : "image";
  return "code";
}

export function columnLetter(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function detectDelimiter(text, isTsv) {
  if (isTsv) return "\t";
  const firstLine = text.slice(0, 2000).split(/\r?\n/)[0] || "";
  let commas = 0, semis = 0, tabs = 0, inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === ",") commas++;
      else if (ch === ";") semis++;
      else if (ch === "\t") tabs++;
    }
  }
  if (tabs > commas && tabs > semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

export function parseCsvTable(text, isTsv = false) {
  const delim = detectDelimiter(text, isTsv);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let truncated = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      if (row.length < MAX_CSV_COLS) row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (row.length < MAX_CSV_COLS) row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length >= MAX_CSV_ROWS + 1) {
        truncated = true;
        break;
      }
    } else {
      field += ch;
    }
  }

  if (!truncated && (field.length > 0 || row.length > 0)) {
    if (row.length < MAX_CSV_COLS) row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }

  const headers = rows[0] ?? [];
  const dataRows = rows.slice(1);
  const colCount = Math.min(
    MAX_CSV_COLS,
    Math.max(headers.length, ...dataRows.slice(0, 40).map(r => r.length), 1),
  );

  const colWidths = [];
  for (let c = 0; c < colCount; c++) {
    let maxLen = Math.max(columnLetter(c).length, (headers[c] || "").length);
    for (let r = 0; r < Math.min(40, dataRows.length); r++) {
      const len = (dataRows[r][c] || "").length;
      if (len > maxLen) maxLen = len;
    }
    colWidths.push(Math.max(76, Math.min(240, maxLen * 7.6 + 22)));
  }

  return { headers, dataRows, colCount, colWidths, truncated, delimiter: delim };
}

export function previewDir() {
  return `${appHome()}/data/fv-preview`;
}

export async function removePreviewFile(relPath) {
  if (!relPath) return;
  const abs = `${appHome()}/${relPath}`;
  await exec("rm", ["-f", abs], { timeout: 2000 }).catch(() => null);
}

export async function stageImagePreview(fullPath, on, token) {
  const ext = getExtension(fullPath) || "png";
  const relPath = `data/fv-preview/img-${token}.${ext}`;
  const dstAbs = `${appHome()}/${relPath}`;
  const dir = previewDir();

  if (!on) {
    const r = await exec(
      "sh",
      ["-c", 'mkdir -p "$1" && ln -sf "$2" "$3" && stat -c "%s" "$2" 2>/dev/null || wc -c < "$2"', "_", dir, fullPath, dstAbs],
      { timeout: 4000 },
    );
    if (r.code !== 0) throw new Error(r.stderr || "Cannot preview image");
    return { relPath, sizeBytes: parseInt((r.stdout || "").trim(), 10) || 0 };
  }

  const remote = await exec(
    "sh",
    ["-c", 'sz=$(wc -c < "$1"); [ "$sz" -le 6291456 ] || { echo "TOO_LARGE"; exit 2; }; base64 -w 0 "$1" 2>/dev/null || base64 "$1"', "_", fullPath],
    { on, timeout: 10000 },
  );
  if (remote.code !== 0) {
    if ((remote.stdout || "").includes("TOO_LARGE")) throw new Error("Remote image exceeds 6 MB preview limit");
    throw new Error(remote.stderr || "Cannot read remote image");
  }
  const b64 = (remote.stdout || "").replace(/\s+/g, "");
  const local = await exec(
    "sh",
    ["-c", 'mkdir -p "$1" && printf "%s" "$2" | base64 -d > "$3"', "_", dir, b64, dstAbs],
    { timeout: 5000 },
  );
  if (local.code !== 0) throw new Error("Failed to decode remote image");
  return { relPath, sizeBytes: Math.floor((b64.length * 3) / 4) };
}

export async function inspectPdf(fullPath, on) {
  const r = await exec("pdfinfo", [fullPath], { on, timeout: 5000 });
  if (r.code !== 0) throw new Error(r.stderr || "pdfinfo unavailable or unreadable PDF");
  const pagesMatch = /^Pages:\s+(\d+)/m.exec(r.stdout || "");
  const titleMatch = /^Title:\s+(.+)$/m.exec(r.stdout || "");
  return {
    pages: Math.max(1, parseInt(pagesMatch?.[1] || "1", 10)),
    title: (titleMatch?.[1] || "").trim(),
  };
}

export async function renderPdfPage(fullPath, on, page, token) {
  const dir = previewDir();
  const baseName = `pdf-${token}-p${page}`;
  const relPath = `data/fv-preview/${baseName}.png`;
  const dstPrefix = `${dir}/${baseName}`;

  if (!on) {
    const r = await exec(
      "sh",
      ["-c", 'mkdir -p "$1" && pdftoppm -png -r 144 -f "$2" -l "$2" -singlefile "$3" "$4"', "_", dir, String(page), fullPath, dstPrefix],
      { timeout: 10000 },
    );
    if (r.code !== 0) throw new Error(r.stderr || "pdftoppm failed to render PDF page");
    return relPath;
  }

  const remote = await exec(
    "sh",
    ["-c", 'pdftoppm -png -r 130 -f "$1" -l "$1" "$2" | base64 -w 0 2>/dev/null || pdftoppm -png -r 130 -f "$1" -l "$1" "$2" | base64', "_", String(page), fullPath],
    { on, timeout: 15000 },
  );
  if (remote.code !== 0 || !remote.stdout) throw new Error(remote.stderr || "Remote pdftoppm unavailable");
  const b64 = remote.stdout.replace(/\s+/g, "");
  const local = await exec(
    "sh",
    ["-c", 'mkdir -p "$1" && printf "%s" "$2" | base64 -d > "$3.png"', "_", dir, b64, dstPrefix],
    { timeout: 5000 },
  );
  if (local.code !== 0) throw new Error("Failed to decode remote PDF page");
  return relPath;
}
