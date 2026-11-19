import { browser, expect } from "@wdio/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeLmStudio, lastUserText, startFakeLmStudio, toolResults } from "../support/fakeLmStudio";

/**
 * Offline agent evals in real Obsidian: the real plugin (Pi agent, built-in MCP
 * server, BM25 search) against a scripted OpenAI-compatible server.
 */
describe("Private AI agent in real Obsidian", function () {
    let llm: FakeLmStudio;

    before(async function () {
        llm = await startFakeLmStudio((body) => {
            const question = lastUserText(body);
            const results = toolResults(body);
            if (/water heater/i.test(question)) {
                if (results.length === 0) return { toolCalls: [{ name: "search_notes", args: { query: "water heater replaced" } }] };
                if (results.length === 1) {
                    const path = results[0].match(/1\. (.+?\.md)/)?.[1] ?? "missing";
                    return { toolCalls: [{ name: "read_note", args: { path } }] };
                }
                const date = results[1].match(/replaced the water heater on (\d{4}-\d{2}-\d{2})/i)?.[1] ?? "unknown";
                return { text: `You replaced the water heater on ${date}.` };
            }
            if (/garden note/i.test(question)) {
                if (results.length === 0) return { toolCalls: [{ name: "create_note", args: { path: "Projects/Garden", content: "- plant tomatoes" } }] };
                return { text: "Created Projects/Garden.md." };
            }
            return { text: "Hello from the fake model." };
        });

        await browser.executeObsidian(async ({ app }, url) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            Object.assign(plugin.settings, { apiEndpoint: url, model: "mock-model", contextMode: "search", allowNoteChanges: true });
            await plugin.saveSettings();
        }, llm.url);
        await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
        await browser.$('[data-type="local-llm-chat-view"] textarea.local-llm-input').waitForExist({ timeout: 10000 });
    });

    after(async function () {
        await llm?.close();
    });

    async function ask(question: string): Promise<void> {
        const input = browser.$('[data-type="local-llm-chat-view"] textarea.local-llm-input');
        await input.setValue(question);
        await browser.$('[data-type="local-llm-chat-view"] .local-llm-send-button').click();
    }

    async function lastAssistantText(): Promise<string> {
        return browser.execute(() => {
            const all = document.querySelectorAll('[data-type="local-llm-chat-view"] .local-llm-message-assistant .local-llm-message-content');
            return (all[all.length - 1]?.textContent ?? "").trim();
        });
    }

    it("answers from the vault by searching and reading notes with tools", async function () {
        await ask("When did I replace the water heater?");
        await browser.waitUntil(async () => (await lastAssistantText()).includes("2024-03-15"), {
            timeout: 20000,
            timeoutMsg: "the agent never answered with the date from the note",
        }).catch(async (e) => {
            throw new Error(`${e.message}. Last reply: "${await lastAssistantText()}". Model requests: ${llm.requests.length}`);
        });
        // The model saw the BM25 hit and the note content, via MCP tools.
        const toolCallsSent = llm.requests.flatMap((r) => (r.messages ?? []).filter((m: any) => m.role === "assistant" && m.tool_calls));
        expect(toolCallsSent.length).toBeGreaterThanOrEqual(2);
        const agentRequest = llm.requests.find((r) => r.stream && r.tools);
        expect(agentRequest.tools.map((t: any) => t.function.name)).toContain("grep_notes");
        const usedNotes = await browser.execute(() =>
            document.querySelector('[data-type="local-llm-chat-view"] .local-llm-used-notes')?.textContent ?? "");
        expect(usedNotes).toContain("Used 1 note");
    });

    it("creates a note when asked", async function () {
        await ask("Please make a garden note");
        await browser.waitUntil(async () => (await lastAssistantText()).includes("Created Projects/Garden.md"), { timeout: 20000 });
        const content = await browser.executeObsidian(async ({ app }) => {
            const f = app.vault.getFileByPath("Projects/Garden.md");
            return f ? app.vault.read(f) : null;
        });
        expect(content).toBe("- plant tomatoes");
    });

    it("serves the vault tools over localhost MCP when enabled", async function () {
        const { port, token } = await browser.executeObsidian(async ({ app }) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            plugin.settings.mcpServerEnabled = true;
            plugin.settings.mcpServerPort = 22399;
            await plugin.saveSettings();
            return { port: plugin.settings.mcpServerPort, token: plugin.settings.mcpServerToken };
        });
        const client = new Client({ name: "e2e", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }));
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain("search_notes");
        const result = await client.callTool({ name: "grep_notes", arguments: { pattern: "Rheem" } });
        expect((result.content as Array<{ text: string }>)[0].text).toContain("Home/Water Heater Replacement.md");
        await client.close();

        await browser.executeObsidian(async ({ app }) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            plugin.settings.mcpServerEnabled = false;
            await plugin.saveSettings();
        });
        await expect(fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" })).rejects.toThrow();
    });

    it("deletes the old embedding index files from disk", async function () {
        const left = await browser.executeObsidian(async ({ app }) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            const adapter = app.vault.adapter;
            const dirs = [`${plugin.manifest.dir}/vector-index`, `${app.vault.configDir}/plugins/ObsidianPrivateAI/vector-index`];
            for (const dir of dirs) {
                if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
            }
            await adapter.write(`${dirs[0]}/embeddings.db`, "sqlite");
            await adapter.write(`${dirs[1]}/text-embeddings.json`, "[]");
            const result = await plugin.removeLegacyVectorStore();
            if (result.errors.length) throw new Error(result.errors.join("; "));
            const checks = [dirs[0], dirs[1], `${app.vault.configDir}/plugins/ObsidianPrivateAI`, plugin.manifest.dir];
            return Promise.all(checks.map((p) => adapter.exists(p)));
        });
        expect(left).toEqual([false, false, false, true]);
    });
});
