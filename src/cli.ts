import { ChatGPTWebWrapper } from "./index.js";

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    throw new Error('Usage: npm run chat -- "Your prompt here"');
  }

  let wrapper = new ChatGPTWebWrapper({
    headless: false,
    browserChannel: process.env.CHROME_CDP_URL ? undefined : process.env.CHROME_USER_DATA_DIR ? "chrome" : "chromium",
    userDataDir: process.env.CHROME_USER_DATA_DIR,
    profileDirectory: process.env.CHROME_PROFILE_DIRECTORY,
    cdpUrl: process.env.CHROME_CDP_URL
  });

  try {
    try {
      await wrapper.start();
    } catch (error) {
      if (!shouldFallbackFromCdp(error)) {
        throw error;
      }

      process.stderr.write(
        "Chrome CDP was unreachable, falling back to a standalone browser session.\n"
      );

      wrapper = new ChatGPTWebWrapper({
        headless: false,
        browserChannel: process.env.CHROME_USER_DATA_DIR ? "chrome" : "chromium",
        userDataDir: process.env.CHROME_USER_DATA_DIR,
        profileDirectory: process.env.CHROME_PROFILE_DIRECTORY
      });

      await wrapper.start();
    }

    await wrapper.ensureReady();
    await wrapper.sendMessage(prompt);
    const response = await wrapper.waitForAssistantResponse();

    process.stdout.write(`${response}\n`);
  } finally {
    await wrapper.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

function shouldFallbackFromCdp(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("connect ECONNREFUSED") ||
    error.message.includes("ECONNREFUSED 127.0.0.1:9222");
}
