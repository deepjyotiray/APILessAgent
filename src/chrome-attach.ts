import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";

const execFileAsync = promisify(execFile);
const DEFAULT_CDP_PORT = Number(process.env.CHROME_CDP_PORT ?? "9222");
const DEFAULT_CDP_URL = `http://127.0.0.1:${DEFAULT_CDP_PORT}`;

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    throw new Error('Usage: npm run chrome:attach -- "Your prompt here"');
  }

  await ensureChromeDebugSession(DEFAULT_CDP_PORT);

  const env = {
    ...process.env,
    CHROME_CDP_URL: process.env.CHROME_CDP_URL ?? DEFAULT_CDP_URL
  };

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", prompt],
    {
      cwd: process.cwd(),
      env
    }
  );

  if (stderr) {
    process.stderr.write(stderr);
  }

  process.stdout.write(stdout);
}

async function ensureChromeDebugSession(port: number): Promise<void> {
  const alreadyUp = await isDebuggerListening(port);
  if (alreadyUp) {
    return;
  }

  const chromeRunning = await isChromeRunning();
  if (chromeRunning) {
    throw new Error(
      [
        `Chrome is already running without remote debugging on port ${port}.`,
        "An already-running Chrome process cannot be converted into an attachable DevTools session.",
        "Close Chrome completely, then run:",
        `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}`,
        `After that, rerun: CHROME_CDP_URL=http://127.0.0.1:${port} npm run chat -- \"Your prompt here\"`
      ].join("\n")
    );
  }

  const chromeBinary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const child = spawn(
    chromeBinary,
    [`--remote-debugging-port=${port}`],
    {
      detached: true,
      stdio: "ignore"
    }
  );
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await isDebuggerListening(port)) {
      return;
    }

    await sleep(500);
  }

  throw new Error(
    `Timed out waiting for Chrome remote debugging on http://127.0.0.1:${port}.`
  );
}

async function isChromeRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-x", "Google Chrome"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function isDebuggerListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/json/version",
        method: "GET",
        timeout: 1_000
      },
      (res) => {
        resolve((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300);
        res.resume();
      }
    );

    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
