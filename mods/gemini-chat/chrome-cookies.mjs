import { createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CHROME_SALT = "saltysalt";
const CHROME_ITERATIONS = 1;
const CHROME_KEY_LEN = 16;
const CHROME_IV = Buffer.alloc(16, 0x20);
const PEANUTS_PASSWORD = "peanuts";
const SHA256_PREFIX_BYTES = 32;
const KEYRING_TIMEOUT_MS = 4000;
const COOKIE_HOSTS = [".google.com", "google.com", "gemini.google.com", ".gemini.google.com"];
const COOKIE_NAMES = ["__Secure-1PSID", "__Secure-1PSIDTS"];

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (raw.startsWith("--profile=")) args.profile = raw.slice("--profile=".length);
    else if (raw.startsWith("--secret-file=")) args.secretFile = raw.slice("--secret-file=".length);
  }
  return args;
}

function isSafeProfileName(profile) {
  if (!profile || typeof profile !== "string") return false;
  if (profile.includes("/") || profile.includes("\\") || profile.includes("\0")) return false;
  return profile !== "." && profile !== "..";
}

function resolveCookieDbPath(profile) {
  const base = join(homedir(), ".config", "google-chrome", profile);
  const candidates = [join(base, "Cookies"), join(base, "Network", "Cookies")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const PYTHON_SECRET_SERVICE_SCRIPT = `
import sys
import dbus

bus = dbus.SessionBus()
service = dbus.Interface(
    bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets"),
    "org.freedesktop.Secret.Service",
)
_, session = service.OpenSession("plain", dbus.String("", variant_level=1))
try:
    unlocked, locked = service.SearchItems({"application": "chrome"})
    item_path = unlocked[0] if unlocked else (locked[0] if locked else None)
    if item_path and not unlocked:
        service.Unlock([item_path])
    if item_path:
        item = dbus.Interface(
            bus.get_object("org.freedesktop.secrets", item_path),
            "org.freedesktop.Secret.Item",
        )
        secret = item.GetSecret(session)
        sys.stdout.buffer.write(bytes(secret[2]))
finally:
    try:
        dbus.Interface(
            bus.get_object("org.freedesktop.secrets", session),
            "org.freedesktop.Secret.Session",
        ).Close()
    except Exception:
        pass
`;

function querySecretServiceViaDbus() {
  try {
    const output = execFileSync("python3", ["-c", PYTHON_SECRET_SERVICE_SCRIPT], {
      encoding: "utf8",
      timeout: KEYRING_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output || null;
  } catch {
    return null;
  }
}

function queryKeyringPassword() {
  const fromDbus = querySecretServiceViaDbus();
  if (fromDbus) return fromDbus;

  const attempts = [
    ["secret-tool", ["lookup", "application", "chrome"]],
    ["kwallet-query", ["-r", "Chrome Safe Storage", "-f", "Chrome Keys", "kdewallet"]],
  ];
  for (const [cmd, cmdArgs] of attempts) {
    try {
      const output = execFileSync(cmd, cmdArgs, {
        encoding: "utf8",
        timeout: KEYRING_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const trimmed = output.replace(/\r?\n$/, "");
      if (trimmed) return trimmed;
    } catch {}
  }
  return null;
}

function deriveChromeKey(password) {
  return pbkdf2Sync(password, CHROME_SALT, CHROME_ITERATIONS, CHROME_KEY_LEN, "sha1");
}

function isPrintableCookieText(buffer) {
  if (!buffer.length) return false;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return true;
}

function stripHostHashPrefix(decrypted, hostKey) {
  if (decrypted.length <= SHA256_PREFIX_BYTES) return decrypted;
  const expectedHash = createHash("sha256").update(hostKey).digest();
  if (decrypted.subarray(0, SHA256_PREFIX_BYTES).equals(expectedHash)) {
    return decrypted.subarray(SHA256_PREFIX_BYTES);
  }
  const remainder = decrypted.subarray(SHA256_PREFIX_BYTES);
  if (!isPrintableCookieText(decrypted.subarray(0, SHA256_PREFIX_BYTES)) && isPrintableCookieText(remainder)) {
    return remainder;
  }
  return decrypted;
}

function decryptChromeValue(encryptedValue, hostKey, keyringPassword) {
  const buf = Buffer.from(encryptedValue);
  if (buf.length <= 3) return "";
  const version = buf.subarray(0, 3).toString("ascii");
  if (version !== "v10" && version !== "v11") return buf.toString("utf8");

  if (version === "v11" && !keyringPassword) {
    throw new Error('Could not read "Chrome Safe Storage" from your desktop keyring (org.freedesktop.secrets / KWallet).');
  }
  const password = version === "v11" ? keyringPassword : PEANUTS_PASSWORD;
  const key = deriveChromeKey(password);
  const decipher = createDecipheriv("aes-128-cbc", key, CHROME_IV);
  const decrypted = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
  return stripHostHashPrefix(decrypted, hostKey).toString("utf8").trim();
}

async function copyDatabaseWithSidecars(dbPath, destDir) {
  const targetDb = join(destDir, "Cookies");
  await copyFile(dbPath, targetDb);
  await chmod(targetDb, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (!existsSync(sidecar)) continue;
    const targetSidecar = `${targetDb}${suffix}`;
    await copyFile(sidecar, targetSidecar);
    await chmod(targetSidecar, 0o600);
  }
  return targetDb;
}

function readGeminiCookiesFromDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const hostPlaceholders = COOKIE_HOSTS.map(() => "?").join(", ");
    const namePlaceholders = COOKIE_NAMES.map(() => "?").join(", ");
    const sql = `
      SELECT host_key, name, value, encrypted_value
      FROM cookies
      WHERE host_key IN (${hostPlaceholders})
        AND name IN (${namePlaceholders})
      ORDER BY last_access_utc DESC
    `;
    const rows = db.prepare(sql).all(...COOKIE_HOSTS, ...COOKIE_NAMES);
    let keyringPassword;
    let keyringQueried = false;
    const extracted = { psid: "", psidts: "" };
    let lastDecryptError = null;

    for (const row of rows) {
      const targetKey = row.name === "__Secure-1PSID" ? "psid" : "psidts";
      if (extracted[targetKey]) continue;
      if (typeof row.value === "string" && row.value.trim()) {
        extracted[targetKey] = row.value.trim();
        continue;
      }
      if (!row.encrypted_value) continue;
      try {
        const rawBuf = Buffer.from(row.encrypted_value);
        const isV11 = rawBuf.length > 3 && rawBuf.subarray(0, 3).toString("ascii") === "v11";
        if (isV11 && !keyringQueried) {
          keyringPassword = queryKeyringPassword();
          keyringQueried = true;
        }
        const plain = decryptChromeValue(rawBuf, String(row.host_key || ""), keyringPassword);
        if (plain) extracted[targetKey] = plain;
      } catch (err) {
        lastDecryptError = err;
      }
    }
    if (!extracted.psid && lastDecryptError) throw lastDecryptError;
    return extracted;
  } finally {
    db.close();
  }
}

async function writeSecretAtomically(secretFile, profileId, cookies) {
  let existing = {};
  try {
    const raw = await readFile(secretFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
  } catch {}

  const updatedAt = Date.now();
  const next = {
    ...existing,
    web: {
      profileId,
      psid: cookies.psid,
      psidts: cookies.psidts,
      updatedAt,
    },
  };

  const dir = dirname(secretFile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = join(dir, `.gemini-secret-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, secretFile);
    await chmod(secretFile, 0o600);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => null);
    throw err;
  }
  return updatedAt;
}

async function main() {
  const { profile, secretFile } = parseArgs(process.argv.slice(2));
  if (!isSafeProfileName(profile)) {
    throw new Error("Invalid Chrome profile name.");
  }
  if (!secretFile) {
    throw new Error("Missing --secret-file path.");
  }

  const dbPath = resolveCookieDbPath(profile);
  if (!dbPath) {
    throw new Error(`Cookies database not found for Chrome profile "${profile}".`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "herdr-gemini-ck-"));
  try {
    await chmod(tempDir, 0o700);
    const copiedDb = await copyDatabaseWithSidecars(dbPath, tempDir);
    const cookies = readGeminiCookiesFromDb(copiedDb);
    if (!cookies.psid) {
      throw new Error(`No __Secure-1PSID cookie found in profile "${profile}". Open gemini.google.com in that profile and sign in first.`);
    }
    const updatedAt = await writeSecretAtomically(secretFile, profile, cookies);
    process.stdout.write(JSON.stringify({
      ok: true,
      profileId: profile,
      hasPsid: Boolean(cookies.psid),
      hasPsidts: Boolean(cookies.psidts),
      updatedAt,
    }) + "\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => null);
  }
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ ok: false, error: err?.message || String(err) }) + "\n");
  process.exit(1);
});
