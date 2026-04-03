import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export type ChatRole = "user" | "assistant" | "system" | "unknown";

export interface ChatMessage {
  role: ChatRole;
  text: string;
}

export interface ChatGPTWebWrapperOptions {
  headless?: boolean;
  userDataDir?: string;
  browserChannel?: "chromium" | "chrome";
  profileDirectory?: string;
  cdpUrl?: string;
  chatUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_CHAT_URL = "https://chatgpt.com/";

export class ChatGPTWebWrapper {
  private readonly headless: boolean;
  private readonly userDataDir: string;
  private readonly browserChannel?: "chrome";
  private readonly profileDirectory?: string;
  private readonly cdpUrl?: string;
  private readonly chatUrl: string;
  private readonly timeoutMs: number;

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(options: ChatGPTWebWrapperOptions = {}) {
    this.headless = options.headless ?? false;
    this.userDataDir = options.userDataDir ?? path.resolve(".auth/chatgpt");
    this.browserChannel = options.browserChannel === "chrome" ? "chrome" : undefined;
    this.profileDirectory = options.profileDirectory;
    this.cdpUrl = options.cdpUrl;
    this.chatUrl = options.chatUrl ?? DEFAULT_CHAT_URL;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async start(): Promise<void> {
    if (this.cdpUrl) {
      await this.attachToRunningChrome();
      return;
    }

    await mkdir(this.userDataDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      channel: this.browserChannel,
      headless: this.headless,
      viewport: { width: 1440, height: 960 },
      args: this.profileDirectory
        ? [`--profile-directory=${this.profileDirectory}`]
        : []
    });

    this.page =
      this.context.pages()[0] ??
      (await this.context.newPage());

    this.page.setDefaultTimeout(this.timeoutMs);
    await this.page.goto(this.chatUrl, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("networkidle").catch(() => undefined);
  }

  async ensureReady(): Promise<void> {
    const page = this.requirePage();

    const promptBox = this.promptBox();
    if (await promptBox.isVisible().catch(() => false)) {
      return;
    }

    throw new Error(
      this.cdpUrl
        ? "ChatGPT composer was not found in the attached Chrome tab. Make sure the running Chrome session is signed in and the page finished loading."
        : "ChatGPT composer was not found. If you are using your real Chrome profile, close all Chrome windows first and confirm that ChatGPT is already logged in for that profile."
    );
  }

  async sendMessage(message: string): Promise<void> {
    const page = this.requirePage();
    const promptBox = this.promptBox();

    await promptBox.click();
    await promptBox.fill(message);

    const sendButton = page.locator('button[data-testid="send-button"]').first();
    await sendButton.waitFor({ state: "visible" });
    await sendButton.click();
  }

  async waitForAssistantResponse(options: { idleMs?: number; timeoutMs?: number } = {}): Promise<string> {
    const page = this.requirePage();
    const idleMs = options.idleMs ?? 2_000;
    const timeoutMs = options.timeoutMs ?? 120_000;

    const stopButton = page.locator('button[data-testid="stop-button"]').first();
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const isGenerating = await stopButton.isVisible().catch(() => false);
      if (isGenerating) {
        await page.waitForTimeout(500);
        continue;
      }

      await page.waitForTimeout(idleMs);

      const stillGenerating = await stopButton.isVisible().catch(() => false);
      if (!stillGenerating) {
        const messages = await this.readMessages();
        const lastAssistant = [...messages].reverse().find((item) => item.role === "assistant");
        if (lastAssistant) {
          return lastAssistant.text;
        }
      }
    }

    throw new Error("Timed out waiting for the assistant response to finish.");
  }

  async readMessages(): Promise<ChatMessage[]> {
    const page = this.requirePage();
    const items = page.locator('[data-message-author-role]');
    const count = await items.count();
    const messages: ChatMessage[] = [];

    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const roleValue = (await item.getAttribute("data-message-author-role")) ?? "unknown";
      const text = (await item.innerText()).trim();

      messages.push({
        role: this.normalizeRole(roleValue),
        text
      });
    }

    return messages;
  }

  async getLastMessage(role?: ChatRole): Promise<ChatMessage | undefined> {
    const messages = await this.readMessages();
    const filtered = role ? messages.filter((message) => message.role === role) : messages;
    return filtered.at(-1);
  }

  async gotoNewChat(): Promise<void> {
    const page = this.requirePage();
    await page.goto(this.chatUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.cdpUrl) {
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
      return;
    } else {
      await this.context?.close();
    }

    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
  }

  private async attachToRunningChrome(): Promise<void> {
    this.browser = await chromium.connectOverCDP(this.cdpUrl!);

    const contexts = this.browser.contexts();
    this.context = contexts[0];
    if (!this.context) {
      throw new Error("No browser context was available on the running Chrome instance.");
    }

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.timeoutMs);
    await this.page.goto(this.chatUrl, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("networkidle").catch(() => undefined);
  }

  private promptBox() {
    const page = this.requirePage();
    return page.locator("#prompt-textarea").first();
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error("Browser session has not been started. Call start() first.");
    }

    return this.page;
  }

  private normalizeRole(role: string): ChatRole {
    if (role === "user" || role === "assistant" || role === "system") {
      return role;
    }

    return "unknown";
  }
}

export async function createChatGPTWebWrapper(
  options: ChatGPTWebWrapperOptions = {}
): Promise<ChatGPTWebWrapper> {
  const wrapper = new ChatGPTWebWrapper(options);
  await wrapper.start();
  return wrapper;
}
