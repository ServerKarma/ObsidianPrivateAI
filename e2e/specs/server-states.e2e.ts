import * as net from "node:net";
import { browser, expect } from "@wdio/globals";
import { FakeLmStudio, startFakeLmStudio } from "../support/fakeLmStudio";
import { askAndWait, errorDialogText, newChatWelcome, processOneImage, useServer, waitForNotice } from "../support/chat";

/**
 * What the user sees when the local server can't do what was asked. These use a
 * closed port and a stub server, so they run anywhere; the live suite repeats the
 * capability cases against a real LM Studio.
 */
describe("Private AI when the server or model can't be used", function () {
    const servers: FakeLmStudio[] = [];

    /** A stub LM Studio that reports these downloaded models; any chat request is answered. */
    async function stubServer(models: object[]): Promise<FakeLmStudio> {
        const server = await startFakeLmStudio(() => ({ text: "The model answered." }), { restModels: models });
        servers.push(server);
        return server;
    }

    /** An address nothing is listening on. */
    async function closedEndpoint(): Promise<string> {
        const port = await new Promise<number>((resolve) => {
            const probe = net.createServer();
            probe.listen(0, "127.0.0.1", () => {
                const { port } = probe.address() as net.AddressInfo;
                probe.close(() => resolve(port));
            });
        });
        return `http://127.0.0.1:${port}/v1/chat/completions`;
    }

    after(async function () {
        for (const server of servers) await server.close();
    });

    describe("LM Studio is not running", function () {
        let endpoint = "";

        before(async function () {
            endpoint = await closedEndpoint();
            await useServer(endpoint);
        });

        it("opens the chat with setup instructions instead of an error", async function () {
            const welcome = await newChatWelcome();
            expect(welcome).toContain("Welcome to Private AI");
            expect(welcome).toContain("lmstudio.ai");
            expect(welcome).toContain("Gemma 4 E4B");
            expect(welcome).toContain("Start the local server");
            expect(await errorDialogText()).toBe("");
        });

        it("starts the plugin without an error when the server is down", async function () {
            await browser.executeObsidian(async ({ app }) => {
                const plugins = (app as any).plugins;
                await plugins.disablePlugin("private-ai");
                await plugins.enablePlugin("private-ai");
            });
            await useServer(endpoint);
            expect(await newChatWelcome()).toContain("Welcome to Private AI");
            expect(await errorDialogText()).toBe("");
        });

        it("answers a message by saying LM Studio can't be reached", async function () {
            const reply = await askAndWait("When did I replace the water heater?");
            expect(reply).toContain("Can't reach LM Studio");
            expect(reply).toContain(new URL(endpoint).origin);
            expect(reply).toContain("Developer");
        });

        it("says so when asked to read image text", async function () {
            await processOneImage("Attachments/offline.png");
            expect(await waitForNotice(/LM Studio isn't running/)).toContain("Can't read image text");
        });
    });

    describe("the server accepts connections but never answers", function () {
        let hung: net.Server;
        let endpoint = "";
        const sockets = new Set<net.Socket>();

        before(async function () {
            hung = net.createServer((socket) => {
                sockets.add(socket);
                socket.on("error", () => undefined);
                socket.on("close", () => sockets.delete(socket));
            });
            await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", () => resolve()));
            endpoint = `http://127.0.0.1:${(hung.address() as net.AddressInfo).port}/v1/chat/completions`;
        });

        after(async function () {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => hung.close(() => resolve()));
        });

        it("opens the chat pane at once and keeps Obsidian usable while it waits", async function () {
            await browser.executeObsidian(async ({ app }, url) => {
                const plugins = (app as any).plugins;
                const plugin = plugins.plugins["private-ai"];
                Object.assign(plugin.settings, { apiEndpoint: url, model: "" });
                await plugin.saveSettings();
                // Restart the plugin so the pane opens against the hung server, as it would on app start.
                await plugins.disablePlugin("private-ai");
                await plugins.enablePlugin("private-ai");
            }, endpoint);

            const started = Date.now();
            await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
            const input = browser.$('[data-type="local-llm-chat-view"] textarea.local-llm-input');
            await input.waitForExist({ timeout: 3000 });
            const firstMessage = await browser.execute(() =>
                (document.querySelector('[data-type="local-llm-chat-view"] .local-llm-message-content')?.textContent ?? "").trim());
            // The pane is there well before the server check could have timed out.
            expect(Date.now() - started).toBeLessThan(3000);
            expect(firstMessage).toContain("Checking your local AI server");

            // Obsidian still does other work while the check is pending.
            const opened = await browser.executeObsidian(async ({ app }) => {
                const file = app.vault.getFileByPath("Home/Dishwasher Repair.md");
                await app.workspace.getLeaf("tab").openFile(file!);
                return app.workspace.getActiveFile()?.path;
            });
            expect(opened).toBe("Home/Dishwasher Repair.md");
            await input.setValue("still typing");
            expect(await input.getValue()).toBe("still typing");
            await input.setValue("");
            expect(await errorDialogText()).toBe("");
        });

        it("gives up after a few seconds and shows the setup instructions", async function () {
            await browser.waitUntil(async () => (await browser.execute(() =>
                document.querySelector('[data-type="local-llm-chat-view"] .local-llm-message-content')?.textContent ?? "")).includes("Welcome to Private AI"), {
                timeout: 15000,
                timeoutMsg: "the placeholder was never replaced",
            });
        });

        it("answers a message within a few seconds instead of hanging", async function () {
            const started = Date.now();
            const reply = await askAndWait("Hello", 15000);
            expect(reply).toContain("Can't reach LM Studio");
            expect(Date.now() - started).toBeLessThan(12000);
        });
    });

    describe("LM Studio is running but no model is downloaded", function () {
        let server: FakeLmStudio;

        before(async function () {
            server = await stubServer([]);
            await useServer(server.url);
        });

        it("opens the chat with how to download a model", async function () {
            const welcome = await newChatWelcome();
            expect(welcome).toContain("no chat model downloaded");
            expect(welcome).toContain("Discover");
            expect(welcome).toContain("Gemma 4 E4B");
            expect(welcome).toContain("Gemma 4 E2B");
        });

        it("answers a message with how to download a model, without calling the model", async function () {
            const reply = await askAndWait("Hello");
            expect(reply).toContain("Download a model first");
            expect(reply).toContain("Discover");
            expect(reply).toContain("Gemma 4 E4B");
            expect(server.requests.length).toBe(0);
        });

        it("counts a server with only an embedding model as having no model", async function () {
            const embeddingOnly = await stubServer([{ type: "embedding", key: "text-embedding-small", loaded_instances: [] }]);
            await useServer(embeddingOnly.url);
            expect(await askAndWait("Hello")).toContain("Download a model first");
        });
    });

    describe("the loaded model can't use tools", function () {
        let server: FakeLmStudio;

        before(async function () {
            server = await stubServer([
                { type: "llm", key: "tool-capable-but-not-loaded", size_bytes: 1, loaded_instances: [], capabilities: { vision: true, trained_for_tool_use: true } },
                { type: "llm", key: "acme/no-tools-7b", size_bytes: 5, loaded_instances: [{ id: "acme/no-tools-7b" }], capabilities: { vision: true, trained_for_tool_use: false } },
            ]);
            await useServer(server.url);
        });

        it("tells the user to use a model with tool support, without calling the model", async function () {
            const reply = await askAndWait("When did I replace the water heater?");
            expect(reply).toContain("This model can't use tools");
            expect(reply).toContain("acme/no-tools-7b");
            expect(reply).toContain("Gemma 4 E4B");
            expect(server.requests.length).toBe(0);
        });

        it("says the same when that model is the one picked in settings", async function () {
            await useServer(server.url, "acme/no-tools-7b");
            expect(await askAndWait("Hello")).toContain("This model can't use tools");
            expect(server.requests.length).toBe(0);
        });
    });

    describe("the loaded model can't read images", function () {
        let server: FakeLmStudio;

        before(async function () {
            server = await stubServer([
                { type: "llm", key: "acme/text-only-4b", size_bytes: 5, loaded_instances: [{ id: "acme/text-only-4b" }], capabilities: { vision: false, trained_for_tool_use: true } },
            ]);
            await useServer(server.url);
        });

        it("shows a notice that the model has no vision, without sending it the image", async function () {
            await processOneImage("Attachments/no-vision.png");
            const notice = await waitForNotice(/can't read images/);
            expect(notice).toContain("acme/text-only-4b");
            expect(notice).toContain("Gemma 4 E4B");
            expect(server.requests.length).toBe(0);
        });

        it("still chats with that model, since it can use tools", async function () {
            expect(await askAndWait("Hello")).toContain("The model answered.");
        });
    });

    describe("no model is loaded", function () {
        it("picks the smallest downloaded model that can use tools", async function () {
            const server = await stubServer([
                { type: "llm", key: "big/tools-70b", size_bytes: 40_000_000_000, loaded_instances: [], capabilities: { vision: true, trained_for_tool_use: true } },
                { type: "llm", key: "tiny/no-tools-1b", size_bytes: 1_000_000_000, loaded_instances: [], capabilities: { vision: false, trained_for_tool_use: false } },
                { type: "llm", key: "small/tools-4b", size_bytes: 5_000_000_000, loaded_instances: [], capabilities: { vision: true, trained_for_tool_use: true } },
                { type: "embedding", key: "text-embedding-small", size_bytes: 100, loaded_instances: [] },
            ]);
            await useServer(server.url);
            expect(await askAndWait("Hello")).toContain("The model answered.");
            const chatRequest = server.requests.find((r) => r.stream);
            expect(chatRequest.model).toBe("small/tools-4b");
        });
    });
});
