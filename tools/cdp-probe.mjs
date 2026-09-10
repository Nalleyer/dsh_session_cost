/**
 * Dev-only CDP probe: drive a headless Chrome/Edge against a running `dsh web`
 * page, report console errors, evaluate one expression, and optionally
 * screenshot and click a selector. Not part of the published package.
 *
 * Usage:
 *   node test/tools/cdp-probe.mjs <url> [--eval-file <file>] [--shot <png>] [--click <selector>]
 *
 * The script prints a JSON report to stdout. Chrome is used for its launcher
 * semantics on Windows (the console dump flags do not work there), so this
 * talks Chrome DevTools Protocol over the global WebSocket instead.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH
  ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const url = process.argv[2] ?? "http://127.0.0.1:8090";
const argOf = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? void 0 : process.argv[index + 1];
};
const evalFile = argOf("--eval-file");
const shotPath = argOf("--shot");
const clickSelector = argOf("--click");
const waitSelector = argOf("--wait") ?? "[data-composer-stats]";
const settleMs = Number(argOf("--settle") ?? "1500");
const port = 9400 + Math.floor(Math.random() * 400);
const userDataDir = mkdtempSync(join(tmpdir(), "dsh-cdp-"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=Translate,BackForwardCache",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--window-size=1440,900",
  "about:blank"
], { stdio: "ignore" });

/** Minimal CDP client over the Node global WebSocket. */
class Session {
  #socket;
  #nextId = 1;
  #pending = new Map();
  events = [];

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== void 0) {
        const entry = this.#pending.get(message.id);
        if (entry === void 0) return;
        this.#pending.delete(message.id);
        if (message.error !== void 0) entry.reject(new Error(`${message.error.message}`));
        else entry.resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true
    });
    if (result.exceptionDetails !== void 0) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
    }
    return result.result.value;
  }
}

/** Wait for the debugging endpoint, then attach to the first page target. */
async function attach() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page !== void 0) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve, { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        return new Session(socket);
      }
    } catch {
      // Browser not up yet.
    }
    await sleep(200);
  }
  throw new Error("cdp: no page target after 20s");
}

const session = await attach();
const consoleErrors = [];
await session.send("Runtime.enable");
await session.send("Page.enable");
await session.send("Log.enable");
await session.send("Page.navigate", { url });

const started = Date.now();
for (;;) {
  await sleep(400);
  const found = await session.evaluate(
    `document.querySelector(${JSON.stringify(waitSelector)}) !== null`
  ).catch(() => false);
  if (found === true) break;
  if (Date.now() - started > 40000) break;
}
await sleep(settleMs);

if (clickSelector !== void 0) {
  await session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(clickSelector)});
    if (el === null) return false;
    el.click();
    return true;
  })()`);
  await sleep(1200);
}

const report = { url, clicked: clickSelector ?? null };
if (evalFile !== void 0) {
  report.value = await session.evaluate(readFileSync(evalFile, "utf8"));
}

report.console = session.events
  .filter((event) => event.method === "Runtime.consoleAPICalled")
  .map((event) => ({
    type: event.params.type,
    text: event.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ")
  }))
  .filter((entry) => entry.type === "error" || entry.type === "warning")
  .slice(0, 40);
report.exceptions = session.events
  .filter((event) => event.method === "Runtime.exceptionThrown")
  .map((event) => event.params.exceptionDetails.exception?.description
    ?? event.params.exceptionDetails.text)
  .slice(0, 20);
report.logEntries = session.events
  .filter((event) => event.method === "Log.entryAdded")
  .map((event) => ({ level: event.params.entry.level, text: event.params.entry.text }))
  .filter((entry) => entry.level === "error")
  .slice(0, 20);

if (shotPath !== void 0) {
  const shot = await session.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  report.screenshot = shotPath;
}

console.log(JSON.stringify(report, null, 2));
chrome.kill();
process.exit(0);
