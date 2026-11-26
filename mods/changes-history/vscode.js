export const VSCODE_PROFILE = "herdr-scm";
const VSCODE_TIMEOUT_MS = 15000;

export async function openInVSCode(exec, { root, on, file = null }) {
  if (!root) {
    return { ok: false, error: "No repository open" };
  }
  if (on) {
    return { ok: false, error: "Open in VS Code is only available for local repositories" };
  }

  const targetPaths = file ? [root, `${root}/${file}`] : [root];
  const args = [
    "--new-window",
    "--profile",
    VSCODE_PROFILE,
    "--disable-extensions",
    "--",
    ...targetPaths,
  ];
  try {
    const launchResult = await exec("code", args, { timeout: VSCODE_TIMEOUT_MS });
    const isSuccess = launchResult.code === 0;
    const errorMessage = isSuccess
      ? null
      : (launchResult.stderr || launchResult.stdout || "Failed to launch VS Code").trim();
    return { ok: isSuccess, error: errorMessage };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || "Failed to launch VS Code") };
  }
}
