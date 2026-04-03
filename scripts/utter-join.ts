#!/usr/bin/env npx tsx
/**
 * utter-join.ts — Join a Google Meet meeting as a guest via Playwright
 *
 * Usage:
 *   npx openutter join <meet-url> --auth
 *   npx openutter join https://meet.google.com/abc-defg-hij --anon --bot-name "OpenUtter Bot"
 *   npx openutter join <meet-url> --anon --bot-name "My Bot" --duration 60m
 *
 * No Google account or OAuth required — joins as a guest and waits for host admission.
 */

import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type PlaywrightMod = typeof import("playwright-core");
type Page = import("playwright-core").Page;
type BrowserContext = import("playwright-core").BrowserContext;

const OPENUTTER_DIR = join(homedir(), ".openutter");
const OPENUTTER_WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace", "openutter");
const CONFIG_FILE = join(OPENUTTER_DIR, "config.json");
const AUTH_FILE = join(OPENUTTER_DIR, "auth.json");
const PID_FILE = join(OPENUTTER_DIR, "otter.pid");
const SCREENSHOT_READY_FILE = join(OPENUTTER_WORKSPACE_DIR, "screenshot-ready.json");
const TRANSCRIPTS_DIR = join(OPENUTTER_WORKSPACE_DIR, "transcripts");

// ── Send image directly to channel ──────────────────────────────────────

/**
 * Send an image to the user's chat via `openclaw message send --media`.
 * If channel/target aren't provided, falls back to printing the marker.
 */
function sendImage(opts: {
  channel?: string;
  target?: string;
  message: string;
  mediaPath: string;
}): void {
  if (opts.channel && opts.target) {
    try {
      execSync(
        `openclaw message send --channel ${opts.channel} --target ${JSON.stringify(opts.target)} --message ${JSON.stringify(opts.message)} --media ${JSON.stringify(opts.mediaPath)}`,
        { stdio: "inherit", timeout: 30_000 },
      );
      console.log(`  Sent image to ${opts.channel}:${opts.target}`);
    } catch (err) {
      console.error("Failed to send image:", err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Send a text-only progress message to the user's chat.
 */
function sendMessage(opts: { channel?: string; target?: string; message: string }): void {
  if (opts.channel && opts.target) {
    try {
      execSync(
        `openclaw message send --channel ${opts.channel} --target ${JSON.stringify(opts.target)} --message ${JSON.stringify(opts.message)}`,
        { stdio: "inherit", timeout: 30_000 },
      );
    } catch {
      // Best-effort — don't block the bot if message fails
    }
  }
}

function buildJoinRecoveryMessage(botName: string, maxJoinRetries: number): string {
  return [
    `🦦 I can try to join again ${maxJoinRetries} times or, for a reliable way, here's my suggestion:`,
    "",
    "Two options:",
    `1. Get admitted manually. When the bot asks to join as "${botName}", have someone in the meeting click "Admit." If the host has "Only people invited" or "host approval required" enabled, it will wait there until they accept.`,
    '2. Authenticate the bot. Run `npx openutter auth` once on the machine running OpenUtter, sign into a Google account, and that session gets saved under `~/.openutter/auth.json`. After that I can join meetings with `--auth`, which usually skips the "ask to join" screen entirely.',
    "",
    "Pick whichever works for you. Once it is allowed in, I can keep recording audio and screenshots like before. I can try again to join whenever you want.",
  ].join("\n");
}

// ── CLI parsing ────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const meetUrl = args.find((a) => !a.startsWith("--"));
  const headed = args.includes("--headed");
  const useAuth = args.includes("--auth");
  const useAnon = args.includes("--anon");
  // Default: camera and mic OFF (bot should join muted). Use --camera / --mic to enable.
  const noCamera = !args.includes("--camera");
  const noMic = !args.includes("--mic");
  const verbose = args.includes("--verbose");
  const durationIdx = args.indexOf("--duration");
  const durationRaw = durationIdx >= 0 ? args[durationIdx + 1] : undefined;
  const botNameIdx = args.indexOf("--bot-name");
  const botName = botNameIdx >= 0 ? args[botNameIdx + 1] : undefined;
  const channelIdx = args.indexOf("--channel");
  const channel = channelIdx >= 0 ? args[channelIdx + 1] : undefined;
  const targetIdx = args.indexOf("--target");
  const target = targetIdx >= 0 ? args[targetIdx + 1] : undefined;

  if (!meetUrl) {
    console.error(
      "Usage: npx openutter join <meet-url> --auth|--anon [--camera] [--mic] [--duration 60m] [--bot-name <name>] [--channel <channel>] [--target <id>]",
    );
    process.exit(1);
  }

  if (!useAuth && !useAnon) {
    console.error("ERROR: You must specify either --auth or --anon.");
    console.error("ASK THE USER which mode they want before retrying. Do NOT choose for them.");
    console.error("  --auth  Join using saved Google account (~/.openutter/auth.json)");
    console.error("  --anon  Join as a guest (no Google account)");
    process.exit(1);
  }

  if (useAuth && useAnon) {
    console.error("ERROR: Cannot use both --auth and --anon.");
    process.exit(1);
  }

  if (useAnon && !botName) {
    console.error("ERROR: --anon requires --bot-name <name>.");
    console.error("ASK THE USER what name they want the bot to use. Do NOT choose a default.");
    process.exit(1);
  }

  // Parse duration to milliseconds
  let durationMs: number | undefined;
  if (durationRaw) {
    const match = durationRaw.match(/^(\d+)(ms|s|m|h)?$/);
    if (match) {
      const value = Number.parseInt(match[1]!, 10);
      const unit = match[2] ?? "ms";
      const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
      durationMs = value * (multipliers[unit] ?? 1);
    }
  }

  const noAuth = useAnon;
  return {
    meetUrl,
    headed,
    noAuth,
    noCamera,
    noMic,
    verbose,
    durationMs,
    botName,
    channel,
    target,
  };
}

// ── Google Meet UI automation ──────────────────────────────────────────

/**
 * Detect if Google Meet has blocked us with "You can't join this video call".
 * Returns true if blocked.
 */
async function isBlockedFromJoining(page: Page): Promise<boolean> {
  try {
    const blocked = page
      .locator("text=/You can't join this video call/i, text=/can.t join this video call/i")
      .first();
    return await blocked.isVisible({ timeout: 2000 });
  } catch {
    return false;
  }
}

/**
 * Dismiss pre-join overlays: "Sign in with your Google account" tooltip,
 * "Your meeting is safe", cookie consent, "Use Gemini to take notes", etc.
 * Runs multiple rounds since popups can appear sequentially.
 */
async function dismissOverlays(page: Page): Promise<void> {
  const dismissTexts = ["Got it", "Dismiss", "OK", "Accept all", "Continue without microphone", "No thanks"];

  for (let round = 0; round < 3; round++) {
    let dismissed = false;

    // Click dismiss/close buttons
    for (const text of dismissTexts) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          console.log(`  Dismissed overlay ("${text}")`);
          dismissed = true;
          await page.waitForTimeout(500);
        }
      } catch {
        // Button not present, that's fine
      }
    }

    // Dismiss "Use Gemini to take notes" banner — click away from it or press Escape
    try {
      const gemini = page.locator('text=/Use Gemini/i').first();
      if (await gemini.isVisible({ timeout: 1000 })) {
        await page.keyboard.press("Escape");
        console.log("  Dismissed Gemini banner");
        dismissed = true;
        await page.waitForTimeout(500);
      }
    } catch {
      // Not present
    }

    // Press Escape to close any remaining tooltips/popups
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    if (!dismissed) break;
  }
}

/**
 * Dismiss dialogs that appear after joining the meeting.
 * e.g. "Others may see your video differently" with a "Got it" button,
 * or "Your meeting is safe" info cards.
 */
async function dismissPostJoinDialogs(page: Page): Promise<void> {
  await page.waitForTimeout(2000);

  // Try multiple rounds — dialogs can appear sequentially
  for (let round = 0; round < 3; round++) {
    let dismissed = false;

    // Click any "Got it", "OK", "Dismiss", "Close" buttons in dialogs
    for (const text of ["Got it", "OK", "Dismiss", "Close"]) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          console.log(`  Dismissed post-join dialog ("${text}")`);
          dismissed = true;
          await page.waitForTimeout(500);
        }
      } catch {
        // Not present
      }
    }

    // Also try Escape to close any modal
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    if (!dismissed) break;
  }
}

/**
 * Turn off camera and microphone on the pre-join page.
 */
async function disableMediaOnPreJoin(page: Page, opts: { noCamera: boolean; noMic: boolean }) {
  if (opts.noMic) {
    try {
      // Try data-is-muted attribute first, then RecallAI's aria-label pattern
      const micBtn = page
        .locator(
          '[aria-label*="microphone" i][data-is-muted="false"], ' +
            'button[aria-label*="Turn off microphone" i]',
        )
        .first();
      if (await micBtn.isVisible({ timeout: 3000 })) {
        await micBtn.click();
        console.log("  Microphone turned off");
      }
    } catch {
      // Already muted or not visible
    }
  }

  if (opts.noCamera) {
    try {
      const camBtn = page
        .locator(
          '[aria-label*="camera" i][data-is-muted="false"], ' +
            'button[aria-label*="Turn off camera" i]',
        )
        .first();
      if (await camBtn.isVisible({ timeout: 3000 })) {
        await camBtn.click();
        console.log("  Camera turned off");
      }
    } catch {
      // Already off or not visible
    }
  }
}

/**
 * Enter the bot's display name in the "Your name" field if it's shown (guest join).
 */
async function enterNameIfNeeded(page: Page, botName: string): Promise<void> {
  try {
    const nameInput = page
      .locator('input[aria-label="Your name"], input[placeholder*="name" i]')
      .first();
    if (await nameInput.isVisible({ timeout: 3000 })) {
      await nameInput.fill(botName);
      console.log(`  Set display name: ${botName}`);
    }
  } catch {
    // Name field not shown — might be signed in already
  }
}

/**
 * Click the "Join now", "Ask to join", or similar button.
 */
async function clickJoinButton(page: Page, maxAttempts = 6): Promise<boolean> {
  const joinSelectors = [
    'button:has-text("Continue without microphone and camera")',
    'button:has-text("Ask to join")',
    'button:has-text("Join now")',
    'button:has-text("Join meeting")',
    'button:has-text("Join")',
    '[data-idom-class*="join"] button',
    "button >> text=/join/i",
  ];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check if we've been blocked before trying more selectors
    const isBlocked = await page
      .evaluate(() => {
        const text = document.body.innerText || "";
        return (
          /you can.t join this video call/i.test(text) || /return(ing)? to home screen/i.test(text)
        );
      })
      .catch(() => false);

    if (isBlocked) {
      console.log("  Detected 'can't join' — aborting join attempt");
      return false;
    }

    for (const selector of joinSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          console.log("  Clicked join button");
          return true;
        }
      } catch {
        // Try next selector
      }
    }

    if (attempt < maxAttempts - 1) {
      console.log(`  Join button not found yet, retrying (${attempt + 1}/${maxAttempts})...`);
      // Take a debug screenshot on first retry to help diagnose
      if (attempt === 0) {
        const debugPath = join(OPENUTTER_WORKSPACE_DIR, "debug-pre-join.png");
        await page.screenshot({ path: debugPath }).catch(() => {});
        console.log(`  [OPENUTTER_DEBUG_IMAGE] ${debugPath}`);
      }
      await page.waitForTimeout(5000);
    }
  }

  return false;
}

/**
 * Wait until we detect that we're actually in the meeting.
 */
async function waitUntilInMeeting(page: Page, timeoutMs = 600_000): Promise<void> {
  console.log("  Waiting to be admitted to the meeting (up to 10 min)...");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    // Check for the end-call button — means we're in the meeting
    try {
      const endCallBtn = page
        .locator('[aria-label*="Leave call" i], [aria-label*="leave" i][data-tooltip*="Leave"]')
        .first();
      if (await endCallBtn.isVisible({ timeout: 2000 })) {
        return;
      }
    } catch {
      // Not visible yet
    }

    // "You're the only one here" or "You've been admitted" — means we're in
    try {
      const inMeetingText = page
        .locator("text=/only one here/i, text=/you.ve been admitted/i")
        .first();
      if (await inMeetingText.isVisible({ timeout: 1000 })) {
        return;
      }
    } catch {
      // Keep waiting
    }

    // Check if explicitly blocked or denied (not just waiting in lobby).
    // Use page.evaluate() for reliable text matching — Playwright text selectors
    // can be fragile with special characters and comma-separated patterns.
    const isBlocked = await page
      .evaluate(() => {
        const text = document.body.innerText || "";
        return (
          /you can.t join this video call/i.test(text) ||
          /return(ing)? to home screen/i.test(text) ||
          /you have been removed/i.test(text) ||
          /denied your request/i.test(text) ||
          /meeting has been locked/i.test(text) ||
          /cannot join/i.test(text)
        );
      })
      .catch(() => false);

    if (isBlocked) {
      throw new Error("Blocked from joining — access denied or meeting unavailable");
    }

    await page.waitForTimeout(2000);
  }

  throw new Error("Timed out waiting to be admitted (10 minutes)");
}

/**
 * Detect when the meeting ends (host ends it, or we get kicked).
 */
async function clickLeaveButton(page: Page): Promise<void> {
  try {
    const leaveBtn = page
      .locator('[aria-label*="Leave call" i], [aria-label*="leave" i][data-tooltip*="Leave"]')
      .first();
    if (await leaveBtn.isVisible({ timeout: 1000 })) {
      await leaveBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    // Best-effort only
  }
}

async function waitForMeetingEnd(
  page: Page,
  opts?: {
    durationMs?: number;
  },
): Promise<string> {
  const start = Date.now();
  const durationMs = opts?.durationMs;

  const checkEnded = async (): Promise<string | null> => {
    try {
      const endedText = page
        .locator(
          "text=/meeting has ended/i, text=/removed from/i, text=/You left the meeting/i, text=/You.ve left the call/i",
        )
        .first();
      if (await endedText.isVisible({ timeout: 500 })) {
        return "Meeting ended";
      }
    } catch {
      // Still in meeting
    }

    if (!page.url().includes("meet.google.com")) {
      return "Navigated away from meeting";
    }

    return null;
  };

  while (true) {
    if (durationMs && Date.now() - start >= durationMs) {
      await clickLeaveButton(page);
      return "Duration limit reached";
    }


    const reason = await checkEnded();
    if (reason) {
      return reason;
    }

    await page.waitForTimeout(3000);
  }
}

// ── Stealth init script to bypass headless detection ───────────────────
const STEALTH_SCRIPT = `
  // Override navigator.webdriver
  Object.defineProperty(navigator, "webdriver", { get: () => false });

  // Ensure window.chrome exists (missing in old headless)
  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }

  // Fake plugins array (headless has 0 plugins)
  Object.defineProperty(navigator, "plugins", {
    get: () => [1, 2, 3, 4, 5],
  });

  // Fake languages
  Object.defineProperty(navigator, "languages", {
    get: () => ["en-US", "en"],
  });

  // Override permissions query for notifications
  const originalQuery = window.Permissions?.prototype?.query;
  if (originalQuery) {
    window.Permissions.prototype.query = function (params) {
      if (params.name === "notifications") {
        return Promise.resolve({ state: "default", onchange: null });
      }
      return originalQuery.call(this, params);
    };
  }

  // Patch WebGL renderer to look like a real GPU
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return "Google Inc. (Apple)";
    if (param === 37446) return "ANGLE (Apple, Apple M1, OpenGL 4.1)";
    return getParameter.call(this, param);
  };
`;

// ── On-demand screenshot via SIGUSR1 ────────────────────────────────────

/**
 * Write PID file and register a SIGUSR1 handler that takes a screenshot
 * of the given page. Call `cleanupPidFile()` on exit.
 */
export function registerScreenshotHandler(page: Page): void {
  writeFileSync(PID_FILE, String(process.pid));

  process.on("SIGUSR1", async () => {
    try {
      const screenshotPath = join(OPENUTTER_WORKSPACE_DIR, "on-demand-screenshot.png");
      await page.screenshot({ path: screenshotPath });
      const payload = JSON.stringify({ path: screenshotPath, timestamp: Date.now() });
      writeFileSync(SCREENSHOT_READY_FILE, payload);
      console.log(`[OPENUTTER_SCREENSHOT] ${screenshotPath}`);
    } catch (err) {
      console.error("Screenshot failed:", err instanceof Error ? err.message : String(err));
    }
  });
}

/**
 * Remove the PID file on exit.
 */
export function cleanupPidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // best-effort
  }
}

// ── Audio capture (PulseAudio + ffmpeg + Soniox) ──────────────────

/**
 * Extract the meeting ID from a Google Meet URL.
 * e.g. "https://meet.google.com/zxb-fxzb-rri" → "zxb-fxzb-rri"
 */
function extractMeetingId(meetUrl: string): string {
  try {
    const url = new URL(meetUrl);
    return url.pathname.replace(/^\//, "").replace(/\//g, "-") || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Set up PulseAudio virtual sink and start ffmpeg recording of browser audio.
 * Returns cleanup function and path to the recorded audio file.
 */
async function setupAudioCapture(
  meetingId: string,
  verbose: boolean,
): Promise<{ audioPath: string; cleanup: () => void }> {
  const audioPath = join(TRANSCRIPTS_DIR, `${meetingId}.wav`);

  // Create a virtual PulseAudio sink for capturing browser audio
  try {
    execSync("pactl load-module module-null-sink sink_name=openutter_capture sink_properties=device.description=OpenUtterCapture", {
      stdio: verbose ? "inherit" : "pipe",
    });
  } catch {
    // Sink might already exist
    if (verbose) console.log("  PulseAudio sink may already exist, continuing...");
  }

  // Set the default sink so Chromium outputs to our virtual sink
  try {
    execSync("pactl set-default-sink openutter_capture", { stdio: verbose ? "inherit" : "pipe" });
  } catch (err) {
    console.error("  Failed to set default PulseAudio sink:", err instanceof Error ? err.message : String(err));
  }

  // Start ffmpeg recording from the monitor source of our virtual sink
  const { execSync: _exec, spawn } = require("node:child_process");
  const ffmpeg = spawn("ffmpeg", [
    "-f", "pulse",
    "-i", "openutter_capture.monitor",
    "-ac", "1",
    "-ar", "16000",
    "-acodec", "pcm_s16le",
    "-y",
    audioPath,
  ], {
    stdio: verbose ? "inherit" : "pipe",
    detached: false,
  });

  if (verbose) console.log(`  ffmpeg recording started -> ${audioPath}`);

  const cleanup = () => {
    try {
      ffmpeg.kill("SIGINT");
      // Give ffmpeg a moment to flush and close the file
      execSync("sleep 1");
    } catch {
      // Best effort
    }
    // Unload the virtual sink
    try {
      execSync("pactl unload-module module-null-sink", { stdio: "pipe" });
    } catch {
      // Best effort
    }
    if (verbose) console.log("  Audio capture stopped");
  };

  return { audioPath, cleanup };
}

/**
 * Transcribe an audio file using Soniox async file API.
 * POST to https://stt-rt.soniox.com/transcribe-file with the audio file.
 * Returns the transcript text.
 */
async function transcribeWithSoniox(audioPath: string, verbose: boolean): Promise<string> {
  const soniox_api_key = process.env.SONIOX_API_KEY || "";
  if (!soniox_api_key) {
    console.error("  SONIOX_API_KEY not set, cannot transcribe");
    return "";
  }

  if (!existsSync(audioPath)) {
    console.error(`  Audio file not found: ${audioPath}`);
    return "";
  }

  console.log("  Transcribing with Soniox...");

  try {
    // Use curl for the multipart upload (simpler than implementing in Node)
    const result = execSync(
      `curl -s -X POST "https://api.soniox.com/v1/transcribe" ` +
      `-H "Authorization: Bearer ${soniox_api_key}" ` +
      `-F "file=@${audioPath}" ` +
      `-F "model=soniox-v2" ` +
      `-F "language_hints=uk,en"`,
      { timeout: 300_000, encoding: "utf-8" }
    );

    const response = JSON.parse(result);
    if (verbose) console.log("  Soniox response:", JSON.stringify(response).substring(0, 200));

    // Extract transcript text from response
    if (response.text) {
      return response.text;
    }
    if (response.words) {
      return response.words.map((w: { text: string }) => w.text).join(" ");
    }
    if (response.segments) {
      return response.segments.map((s: { text: string }) => s.text).join("\n");
    }

    console.warn("  Unexpected Soniox response format");
    return JSON.stringify(response);
  } catch (err) {
    console.error("  Soniox transcription failed:", err instanceof Error ? err.message : String(err));
    return "";
  }
}



export async function joinMeeting(opts: {
  meetUrl: string;
  headed?: boolean;
  noAuth?: boolean;
  noCamera?: boolean;
  noMic?: boolean;
  verbose?: boolean;
  durationMs?: number;
  botName?: string;
  channel?: string;
  target?: string;
}): Promise<{ context: BrowserContext; page: Page; reason: string }> {
  const {
    meetUrl,
    headed = false,
    noAuth = false,
    noCamera = true,
    noMic = true,
    verbose = false,
    durationMs,
    botName: botNameOpt,
    channel,
    target,
  } = opts;

  // Resolve bot name from config or arg
  let botName = botNameOpt ?? "OpenUtter Bot";
  if (!botNameOpt && existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as { botName?: string };
      if (config.botName) {
        botName = config.botName;
      }
    } catch {
      // Use default
    }
  }

  mkdirSync(OPENUTTER_DIR, { recursive: true });
  mkdirSync(OPENUTTER_WORKSPACE_DIR, { recursive: true });

  console.log(`OpenUtter — Joining meeting: ${meetUrl}`);
  console.log(`  Bot name: ${botName}`);
  console.log(`  Camera: ${noCamera ? "off" : "on"}, Mic: ${noMic ? "off" : "on"}`);
  if (durationMs) {
    console.log(`  Max duration: ${Math.round(durationMs / 60_000)}m`);
  }

  let pw: PlaywrightMod;
  try {
    pw = await import("playwright-core");
  } catch {
    console.error("playwright-core not found. Run `npm install` or use `npx openutter join ...`.");
    process.exit(1);
  }

  // Launch browser with fake media devices (no actual camera/mic needed on VM)
  const userDataDir = join(OPENUTTER_DIR, "chrome-profile");
  mkdirSync(userDataDir, { recursive: true });

  const hasAuth = !noAuth && existsSync(AUTH_FILE);
  if (noAuth) {
    console.log("  Joining as guest (--anon)");
  } else if (hasAuth) {
    console.log(`  Using saved auth: ${AUTH_FILE}`);
  } else {
    console.log("  No auth.json found — joining as guest (run `npx openutter auth` to sign in)");
  }

  const chromiumArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--disable-dev-shm-usage",
    "--window-size=1280,720",
  ];

  // In headless mode, use Chrome's new built-in headless (harder to detect)
  if (!headed) {
    chromiumArgs.push("--headless=new", "--disable-gpu");
  }

  const contextOpts: Record<string, unknown> = {
    headless: true, // We pass --headless=new via args instead
    args: chromiumArgs,
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: { width: 1280, height: 720 },
    permissions: ["camera", "microphone"],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };

  // If auth.json exists, use a non-persistent context with storageState
  // (persistent context + storageState is not supported by Playwright)
  let context: BrowserContext;
  let page: Page;

  if (hasAuth) {
    const browser = await pw.chromium.launch({
      headless: !headed,
      args: chromiumArgs,
      ignoreDefaultArgs: ["--enable-automation"],
    });
    context = await browser.newContext({
      storageState: AUTH_FILE,
      viewport: { width: 1280, height: 720 },
      permissions: ["camera", "microphone"],
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page = await context.newPage();
  } else {
    context = await pw.chromium.launchPersistentContext(userDataDir, contextOpts as any);
    page = context.pages()[0] ?? (await context.newPage());
  }

  // Stealth patches: mask headless indicators before any page loads
  await context.addInitScript(STEALTH_SCRIPT);

  // Navigate to the Google Meet URL and attempt to join.
  // If blocked ("You can't join this video call"), retry with a fresh incognito context.
  const MAX_JOIN_RETRIES = 3;
  let currentContext = context;
  let currentPage = page;
  let joined = false;

  sendMessage({ channel, target, message: `🦦 Trying to join the meeting (up to 3 attempts)...` });

  for (let attempt = 1; attempt <= MAX_JOIN_RETRIES; attempt++) {
    console.log(`\nNavigating to meeting... (attempt ${attempt}/${MAX_JOIN_RETRIES})`);
    await currentPage.goto(meetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await currentPage.waitForTimeout(3000);

    // Handle overlays and consent screens
    await dismissOverlays(currentPage);

    // Check if Google Meet blocked us
    if (await isBlockedFromJoining(currentPage)) {
      console.warn(`  Blocked: "You can't join this video call" (attempt ${attempt})`);

      if (attempt < MAX_JOIN_RETRIES) {
        // Close the current context and retry with a fresh incognito context
        console.log("  Retrying with fresh incognito browser context...");
        await currentContext.close();

        const browser = await pw.chromium.launch({
          headless: !headed,
          args: chromiumArgs,
          ignoreDefaultArgs: ["--enable-automation"],
        });

        currentContext = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          permissions: ["camera", "microphone"],
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        });

        await currentContext.addInitScript(STEALTH_SCRIPT);
        currentPage = await currentContext.newPage();
        continue;
      }

      // All retries exhausted
      const screenshotPath = join(OPENUTTER_WORKSPACE_DIR, "debug-join-failed.png");
      await currentPage.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`[OPENUTTER_DEBUG_IMAGE] ${screenshotPath}`);
      sendMessage({
        channel,
        target,
        message: buildJoinRecoveryMessage(botName, MAX_JOIN_RETRIES),
      });
      sendImage({
        channel,
        target,
        message: "Blocked from joining after multiple attempts. Here's what the bot saw:",
        mediaPath: screenshotPath,
      });
      await currentContext.close();
      throw new Error(
        `Blocked from joining after ${MAX_JOIN_RETRIES} attempts. Debug screenshot: ${screenshotPath}`,
      );
    }

    // Enter bot name (guest join)
    await enterNameIfNeeded(currentPage, botName);

    // Disable camera and mic on the pre-join page
    await disableMediaOnPreJoin(currentPage, { noCamera, noMic });
    await currentPage.waitForTimeout(1000);

    // Click join button
    console.log("\nAttempting to join...");
    joined = await clickJoinButton(currentPage);

    // Handle 2-step join preview (RecallAI pattern: a second "Join now" may appear)
    if (joined) {
      await currentPage.waitForTimeout(2000);
      try {
        const secondJoin = currentPage.locator('button:has-text("Join now")').first();
        if (await secondJoin.isVisible({ timeout: 2000 })) {
          await secondJoin.click();
          console.log("  Clicked second join button (2-step preview)");
        }
      } catch {
        // No second join button — single-step flow
      }
    }

    // If join button clicked, wait until we're in the meeting (or blocked)
    if (joined) {
      registerScreenshotHandler(currentPage);
      sendMessage({
        channel,
        target,
        message: `🦦 Waiting to be admitted — please ask the host to let "${botName}" in`,
      });
      try {
        await waitUntilInMeeting(currentPage);
        break; // Successfully in the meeting
      } catch (err) {
        // Post-join block (e.g. "You can't join this video call" after clicking join)
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Post-join block: ${msg} (attempt ${attempt})`);
        joined = false;
        // Fall through to retry logic below
      }
    }

    // Join button not found or post-join block — retry with fresh context
    if (attempt < MAX_JOIN_RETRIES) {
      console.log(`  Retrying with fresh context... (attempt ${attempt}/${MAX_JOIN_RETRIES})`);
      await currentContext.close();

      const browser = await pw.chromium.launch({
        headless: !headed,
        args: chromiumArgs,
        ignoreDefaultArgs: ["--enable-automation"],
      });

      currentContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        permissions: ["camera", "microphone"],
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      });

      await currentContext.addInitScript(STEALTH_SCRIPT);
      currentPage = await currentContext.newPage();
      continue;
    }
  }

  if (!joined) {
    const screenshotPath = join(OPENUTTER_WORKSPACE_DIR, "debug-join-failed.png");
    await currentPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error("Could not join the meeting after all attempts.");
    console.error(`[OPENUTTER_DEBUG_IMAGE] ${screenshotPath}`);
    sendMessage({
      channel,
      target,
      message: buildJoinRecoveryMessage(botName, MAX_JOIN_RETRIES),
    });
    sendImage({
      channel,
      target,
      message: "Could not join the meeting. Here is what the bot saw:",
      mediaPath: screenshotPath,
    });
    await currentContext.close();
    throw new Error(
      `Failed to join after ${MAX_JOIN_RETRIES} attempts. Debug screenshot: ${screenshotPath}`,
    );
  }
  // Take a screenshot to confirm we're in the meeting
  const successScreenshotPath = join(OPENUTTER_WORKSPACE_DIR, "joined-meeting.png");
  await currentPage.screenshot({ path: successScreenshotPath });
  console.log("\n✅ Successfully joined the meeting!");
  console.log(`[OPENUTTER_JOINED] ${meetUrl}`);
  console.log(`[OPENUTTER_SUCCESS_IMAGE] ${successScreenshotPath}`);
  sendImage({
    channel,
    target,
    message: "Successfully joined the meeting!",
    mediaPath: successScreenshotPath,
  });

  // Dismiss post-join dialogs (e.g. "Others may see your video differently" → "Got it")
  await dismissPostJoinDialogs(currentPage);

  const meetingId = extractMeetingId(meetUrl);
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPTS_DIR, `${meetingId}.txt`);
  writeFileSync(transcriptPath, "");

  // ── Audio recording via PulseAudio + ffmpeg ──
  sendMessage({ channel, target, message: `🦦 Starting audio recording (Soniox transcription)...` });
  const { audioPath, cleanup: cleanupAudio } = await setupAudioCapture(meetingId, verbose);

  sendMessage({
    channel,
    target,
    message: `🦦 All set! Recording audio. Transcript will be generated after meeting ends.`,
  });

  // Wait for meeting to end
  console.log("Waiting in meeting... (Ctrl+C to leave)");
  const reason = await waitForMeetingEnd(currentPage, { durationMs });
  console.log(`\nLeaving meeting: ${reason}`);

  // Stop recording
  cleanupAudio();

  // Transcribe with Soniox
  sendMessage({ channel, target, message: `🦦 Meeting ended (${reason}). Transcribing audio with Soniox...` });
  const transcript = await transcribeWithSoniox(audioPath, verbose);
  if (transcript) {
    writeFileSync(transcriptPath, transcript);
    console.log(`[OPENUTTER_TRANSCRIPT] ${transcriptPath}`);
    sendMessage({ channel, target, message: `🦦 Transcript ready!` });
  } else {
    sendMessage({ channel, target, message: `🦦 Meeting ended (${reason}). Audio transcription failed.` });
  }
  return { context: currentContext, page: currentPage, reason };
}

// ── CLI entry ──────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const { context } = await joinMeeting(opts);
  await context.close();
  cleanupPidFile();
  console.log("Done.");
}

const isMain = process.argv[1]?.endsWith("utter-join.ts");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
