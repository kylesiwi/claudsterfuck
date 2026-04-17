import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const GEMINI_STDIN_PROMPT =
  "Read the complete task instructions from stdin and follow them exactly. Treat stdin as the authoritative task.";

export function buildTerminationCommand(pid, platform = process.platform) {
  if (!pid) {
    return null;
  }

  if (platform === "win32") {
    return {
      command: "taskkill",
      args: ["/F", "/T", "/PID", String(pid)]
    };
  }

  return null;
}

export function requestTermination(child, options = {}) {
  if (!child?.pid) {
    return;
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    try {
      child.kill();
    } catch {}

    const command = buildTerminationCommand(child.pid, platform);
    if (!command) {
      return;
    }

    const terminator = (options.spawnFn ?? spawn)(command.command, command.args, {
      stdio: "ignore",
      windowsHide: true
    });
    terminator.on("error", () => {});
    terminator.unref?.();
    return;
  }

  try {
    child.kill();
  } catch {}
}

export function onceFinished(child, { stdin, timeoutMs, terminate = requestTermination, onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let lineBuffer = "";

    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate(child);
          }, timeoutMs)
        : null;

    function cleanup() {
      if (timer) {
        clearTimeout(timer);
      }
    }

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;

      if (onStdoutLine) {
        lineBuffer += text;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          onStdoutLine(line);
        }
      }
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.stdin?.on("error", () => {});

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      // Flush any remaining partial line that arrived without a trailing newline.
      if (onStdoutLine && lineBuffer.length > 0) {
        onStdoutLine(lineBuffer);
        lineBuffer = "";
      }

      resolve({
        exitCode: timedOut ? -1 : code ?? 1,
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut
      });
    });

    if (stdin != null) {
      child.stdin?.write(stdin);
    }
    child.stdin?.end();
  });
}

function quoteForCmd(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Resolve the native codex.exe binary from the platform-specific optional package bundled
 * inside @openai/codex/node_modules. Spawning the native binary directly avoids the JS wrapper
 * (bin/codex.js) which itself spawns codex.exe without windowsHide:true, causing a console
 * window to flash on Windows.
 *
 * Returns the absolute path to codex.exe, or null if not found.
 */
export function resolveCodexNativeBinary(npmShimDir) {
  if (!npmShimDir || process.platform !== "win32") {
    return null;
  }

  const codexPkgDir = path.join(npmShimDir, "node_modules", "@openai", "codex");
  if (!fs.existsSync(codexPkgDir)) {
    return null;
  }

  // Map Node.js arch to Codex's platform package suffix and Rust target triple
  const archMap = {
    x64: { suffix: "win32-x64", triple: "x86_64-pc-windows-msvc" },
    arm64: { suffix: "win32-arm64", triple: "aarch64-pc-windows-msvc" }
  };
  const mapping = archMap[process.arch];
  if (!mapping) {
    return null;
  }

  const binaryPath = path.join(
    codexPkgDir,
    "node_modules",
    "@openai",
    `codex-${mapping.suffix}`,
    "vendor",
    mapping.triple,
    "codex",
    "codex.exe"
  );

  return fs.existsSync(binaryPath) ? binaryPath : null;
}

/**
 * Resolve the JS bin entrypoint for @openai/codex from the global npm package directory.
 * Reads the installed package.json to find the declared bin entry rather than guessing paths.
 * Returns an absolute path to the JS file, or null if the package is not found there.
 * Fallback for platforms where native binary resolution isn't available.
 */
export function resolveCodexNodeEntrypoint(npmShimDir) {
  if (!npmShimDir) {
    return null;
  }

  const packageJsonPath = path.join(npmShimDir, "node_modules", "@openai", "codex", "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const binField = pkg.bin;
    const binRelative =
      typeof binField === "string"
        ? binField
        : binField && typeof binField === "object"
          ? (binField.codex ?? Object.values(binField)[0] ?? null)
          : null;

    if (!binRelative) {
      return null;
    }

    const fullPath = path.join(npmShimDir, "node_modules", "@openai", "codex", binRelative);
    return fs.existsSync(fullPath) ? fullPath : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Gemini CLI Node.js entrypoint directly from the npm global install.
 * Reads the installed package.json to find the declared bin entry rather than guessing paths.
 * Returns an absolute path to the JS file, or null if the package is not found there.
 */
export function resolveGeminiNodeEntrypoint(npmShimDir) {
  if (!npmShimDir) {
    return null;
  }

  const packageJsonPath = path.join(npmShimDir, "node_modules", "@google", "gemini-cli", "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const binField = pkg.bin;
    const binRelative =
      typeof binField === "string"
        ? binField
        : binField && typeof binField === "object"
          ? (binField.gemini ?? Object.values(binField)[0] ?? null)
          : null;

    if (!binRelative) {
      return null;
    }

    const fullPath = path.join(npmShimDir, "node_modules", "@google", "gemini-cli", binRelative);
    return fs.existsSync(fullPath) ? fullPath : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the final command and args to use when spawning a process on Windows.
 * Accepts an optional platform override so the logic can be unit-tested on any OS.
 *
 * For Codex and Gemini the priority order is:
 *   1. Direct Node invocation via the JS bin entrypoint (avoids cmd.exe/PowerShell entirely)
 *   2. PowerShell shim (avoids cmd.exe quoting and length limits)
 *   3. Raw command (let PATH resolution handle it)
 *   4. cmd.exe /c .cmd shim (last resort — old default, kept for compatibility)
 *
 * Direct Node invocation is critical for CLIs that receive stdin input, because
 * PowerShell shims do not forward stdin reliably (ExpectingInput gate).
 */
export function resolveWindowsCommandWithArgs(command, args, platform = process.platform) {
  if (platform !== "win32") {
    return {
      command,
      args
    };
  }

  const npmShimDir = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "";
  const powershellShim = npmShimDir ? path.join(npmShimDir, `${command}.ps1`) : "";
  const cmdShim = npmShimDir ? path.join(npmShimDir, `${command}.cmd`) : "";

  if (command === "codex") {
    // Prefer spawning the native binary directly so that our windowsHide:true applies
    // end-to-end. The JS wrapper (bin/codex.js) re-spawns codex.exe without windowsHide,
    // which opens a console window on every worker run.
    const nativeBinary = resolveCodexNativeBinary(npmShimDir);
    if (nativeBinary) {
      return {
        command: nativeBinary,
        args
      };
    }

    const nodeEntrypoint = resolveCodexNodeEntrypoint(npmShimDir);
    if (nodeEntrypoint) {
      return {
        command: process.execPath,
        args: [nodeEntrypoint, ...args]
      };
    }

    if (powershellShim && fs.existsSync(powershellShim)) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", powershellShim, ...args]
      };
    }

    // cmd.exe kept as last resort — no longer the default path for Codex on Windows.
    if (cmdShim && fs.existsSync(cmdShim)) {
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", [cmdShim, ...args].map(quoteForCmd).join(" ")]
      };
    }

    return {
      command,
      args
    };
  }

  if (command === "gemini") {
    const nodeEntrypoint = resolveGeminiNodeEntrypoint(npmShimDir);
    if (nodeEntrypoint) {
      return {
        command: process.execPath,
        args: ["--no-warnings=DEP0040", nodeEntrypoint, ...args]
      };
    }
  }

  if (powershellShim && fs.existsSync(powershellShim)) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", powershellShim, ...args]
    };
  }

  return {
    command,
    args
  };
}

export async function runCommand(command, args, options = {}) {
  const resolved = resolveWindowsCommandWithArgs(command, args);
  const child = (options.spawnFn ?? spawn)(resolved.command, resolved.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  return onceFinished(child, {
    stdin: options.stdin,
    timeoutMs: options.timeoutMs,
    terminate: (runningChild) =>
      requestTermination(runningChild, {
        platform: options.platform,
        spawnFn: options.spawnFn
      }),
    onStdoutLine: options.onStdoutLine
  });
}

export async function binaryAvailable(command, args = ["--help"], options = {}) {
  try {
    const result = await runCommand(command, args, {
      cwd: options.cwd,
      env: options.env
    });

    return {
      available: result.exitCode === 0,
      detail:
        result.exitCode === 0
          ? `${command} is available`
          : `${command} exited with code ${result.exitCode}`
    };
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseJson(text) {
  try {
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function summarizeError(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  return lines.slice(-6).join(" | ");
}

function timeoutSummary(timeoutMs) {
  return `Worker timed out after ${Math.max(1, Math.round((timeoutMs ?? 0) / 1000))}s`;
}

/**
 * Extract a JSON object from text that may be plain JSON, markdown-fenced JSON,
 * or a JSON object embedded somewhere in prose output.
 * Returns the parsed object/array, or null if no valid JSON is found.
 */
export function extractJson(text) {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {}
  }

  return null;
}

/**
 * Return true if artifactPath resolves to a location strictly inside workspaceRoot.
 * Rejects path traversal (../), absolute paths, and the workspace root itself.
 */
export function isPathSafe(workspaceRoot, artifactPath) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedArtifact = path.resolve(workspaceRoot, artifactPath);
  const relative = path.relative(resolvedRoot, resolvedArtifact);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Parse finalOutput as JSON and write any declared artifacts to disk inside cwd.
 * Writes an artifacts.json manifest to runArtifactsDir regardless of individual outcomes.
 * Returns an array of per-artifact status records, or null if the output has no artifacts.
 */
function writeArtifactsFromOutput(finalOutput, cwd, runArtifactsDir) {
  const parsed = extractJson(finalOutput);

  if (!parsed || !Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0) {
    return null;
  }

  const results = [];

  for (const artifact of parsed.artifacts) {
    if (typeof artifact.path !== "string" || artifact.path.trim() === "") {
      results.push({ path: artifact.path ?? null, status: "skipped", reason: "missing path" });
      continue;
    }
    if (typeof artifact.content !== "string") {
      results.push({ path: artifact.path, status: "skipped", reason: "missing content" });
      continue;
    }
    if (!isPathSafe(cwd, artifact.path)) {
      results.push({ path: artifact.path, status: "rejected", reason: "path outside workspace" });
      continue;
    }

    const targetPath = path.resolve(cwd, artifact.path);
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, artifact.content, artifact.encoding ?? "utf8");
      results.push({ path: artifact.path, status: "written", targetPath });
    } catch (error) {
      results.push({
        path: artifact.path,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  try {
    fs.writeFileSync(
      path.join(runArtifactsDir, "artifacts.json"),
      `${JSON.stringify(results, null, 2)}\n`,
      "utf8"
    );
  } catch {}

  return results;
}

export async function runCodexTask(options) {
  ensureDirectory(options.outputFile);
  const runArtifactsDir = path.dirname(options.outputFile);

  const args = [
    "exec",
    "-",
    "-C",
    options.cwd,
    "--skip-git-repo-check",
    "--sandbox",
    options.writeEnabled ? "workspace-write" : "read-only",
    "--output-last-message",
    options.outputFile
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  // Live streaming: append each stdout line to stdout.live.txt and maintain progress.json
  // while the process is running so the run is diagnosable before exit.
  const liveStdoutPath = path.join(runArtifactsDir, "stdout.live.txt");
  const progressPath = path.join(runArtifactsDir, "progress.json");
  let liveLineCount = 0;

  function writeProgress(partial) {
    try {
      fs.writeFileSync(
        progressPath,
        `${JSON.stringify(
          { lastLineAt: new Date().toISOString(), lineCount: liveLineCount, partial },
          null,
          2
        )}\n`,
        "utf8"
      );
    } catch {}
  }

  function onStdoutLine(line) {
    try {
      fs.appendFileSync(liveStdoutPath, `${line}\n`, "utf8");
    } catch {}
    liveLineCount += 1;
    if (liveLineCount === 1 || liveLineCount % 20 === 0) {
      writeProgress(true);
    }
  }

  const result = await runCommand("codex", args, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.prompt,
    timeoutMs: options.timeoutMs,
    onStdoutLine,
    spawnFn: options.spawnFn
  });

  writeProgress(false);

  const finalOutput = fs.existsSync(options.outputFile)
    ? fs.readFileSync(options.outputFile, "utf8").trim()
    : "";
  // Write-enabled routes produce file-system changes as their primary output.
  // Empty last-message.txt with a clean exit is valid for those routes.
  const effectiveExitCode =
    finalOutput.length === 0 && result.exitCode === 0 && !options.writeEnabled
      ? 1
      : result.exitCode;
  const errorSummary = result.timedOut
    ? timeoutSummary(options.timeoutMs)
    : effectiveExitCode === 0
      ? null
      : summarizeError(result.stderr || result.stdout) || (finalOutput.length === 0 ? "Codex produced no output" : null);

  // Artifact handoff: when the route uses return-artifacts mode, parse the structured
  // JSON response and write the declared files to disk using Node's fs instead of relying
  // on Codex's sandboxed patch/write tools, which can hit Windows command-line length limits
  // for large generated files.
  const writtenArtifacts =
    options.artifactMode === "return-artifacts" && finalOutput
      ? writeArtifactsFromOutput(finalOutput, options.cwd, runArtifactsDir)
      : null;

  return {
    exitCode: effectiveExitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    finalOutput,
    providerSessionId: null,
    errorSummary,
    liveStdoutFile: liveLineCount > 0 ? liveStdoutPath : null,
    progressFile: progressPath,
    writtenArtifacts,
    normalized: {
      provider: "codex",
      status: effectiveExitCode === 0 ? "completed" : "failed",
      finalOutput,
      providerSessionId: null,
      errorSummary
    }
  };
}

export async function runGeminiTask(options) {
  const args = [
    "-p",
    GEMINI_STDIN_PROMPT,
    "--output-format",
    "json",
    "--approval-mode",
    options.writeEnabled ? "yolo" : "plan"
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  const result = await runCommand("gemini", args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}), GEMINI_CLI_NO_RELAUNCH: "true" },
    stdin: options.prompt,
    timeoutMs: options.timeoutMs,
    spawnFn: options.spawnFn
  });

  const parsed = parseJson(result.stdout);
  const providerSessionId = typeof parsed?.session_id === "string" ? parsed.session_id : null;
  const finalOutput =
    typeof parsed?.response === "string" ? parsed.response.trim() : result.stdout.trim();
  const effectiveExitCode =
    finalOutput.length === 0 && result.exitCode === 0
      ? 1
      : result.exitCode;
  const errorSummary = result.timedOut
    ? timeoutSummary(options.timeoutMs)
    : effectiveExitCode === 0
      ? null
      : summarizeError(result.stderr || result.stdout) || (finalOutput.length === 0 ? "Gemini produced no output" : null);

  return {
    exitCode: effectiveExitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    finalOutput,
    providerSessionId,
    errorSummary,
    normalized: {
      provider: "gemini",
      status: effectiveExitCode === 0 ? "completed" : "failed",
      finalOutput,
      providerSessionId,
      errorSummary
    }
  };
}

export async function getProviderAvailability(cwd) {
  const [codex, gemini] = await Promise.all([
    binaryAvailable("codex", ["--help"], { cwd }),
    binaryAvailable("gemini", ["--help"], { cwd })
  ]);

  return {
    codex,
    gemini
  };
}
