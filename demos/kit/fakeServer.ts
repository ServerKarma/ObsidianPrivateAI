import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted local model server for demo recordings. Speaks the OpenAI-compatible
 * chat completions API (streamed), plus either LM Studio's or Ollama's model listing.
 * Only the model's words are scripted; everything on screen is the real plugin.
 */
export type Reply = { toolCalls: Array<{ name: string; args: object }> } | { text: string };

export interface FakeServer {
    url: string;
    requests: any[];
    /** Ollama only: marks a model as loaded with this context length (/api/ps). */
    load(name: string, contextLength: number): void;
    close(): Promise<void>;
}

export interface FakeOptions {
    kind?: "lmstudio" | "ollama";
    port?: number;
    /** Ollama models: name, size and capabilities, as /api/tags + /api/show report them. */
    ollamaModels?: Array<{ name: string; size: number; capabilities: string[] }>;
    /** Delay before a reply and between streamed words, so it reads like a real model. */
    delayMs?: number;
}

export async function startFake(respond: (body: any) => Reply, options: FakeOptions = {}): Promise<FakeServer> {
    const kind = options.kind ?? "lmstudio";
    const models = options.ollamaModels ?? [];
    const running = new Map<string, number>();
    const requests: any[] = [];
    let n = 0;
    const pause = () => new Promise((r) => setTimeout(r, options.delayMs ?? 0));
    const server = http.createServer((req, res) => {
        const origin = req.headers.origin;
        const cors = { "Access-Control-Allow-Origin": origin ?? "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
        const json = (status: number, value: unknown) => {
            res.writeHead(status, { ...cors, "Content-Type": "application/json" });
            res.end(JSON.stringify(value));
        };
        if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", async () => {
            const body = raw ? JSON.parse(raw) : {};
            const p = (req.url ?? "").split("?")[0];
            if (kind === "ollama") {
                if (p === "/api/tags") return json(200, { models: models.map((m) => ({ name: m.name, model: m.name, size: m.size, digest: `sha-${m.name}` })) });
                if (p === "/api/ps") return json(200, { models: [...running].map(([name, context_length]) => ({ name, model: name, context_length })) });
                if (p === "/api/show") {
                    const m = models.find((x) => x.name === body.model);
                    return m ? json(200, { capabilities: m.capabilities, parameters: "" }) : json(404, { error: "not found" });
                }
                if (p === "/v1/models") return json(200, { object: "list", data: models.map((m) => ({ id: m.name, object: "model" })) });
            } else if (req.method === "GET") {
                return json(200, { data: [{ id: "mock-model" }] });
            }
            if (!p.endsWith("/chat/completions")) return json(404, { error: "not found" });
            requests.push(body);
            const reply = respond(body);
            const base = { id: "chatcmpl-demo", object: "chat.completion.chunk", created: 0, model: body.model ?? "mock-model" };
            if (!body.stream) {
                return json(200, { ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "text" in reply ? reply.text : "" }, finish_reason: "stop" }] });
            }
            res.writeHead(200, { ...cors, "Content-Type": "text/event-stream" });
            const send = (delta: object, finish: string | null = null) =>
                res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
            await pause();
            if ("toolCalls" in reply) {
                reply.toolCalls.forEach((call, index) => send({ tool_calls: [{ index, id: `call_${++n}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }));
                send({}, "tool_calls");
            } else {
                for (const word of reply.text.split(/(?<= )/)) { send({ content: word }); await pause(); }
                send({}, "stop");
            }
            res.end("data: [DONE]\n\n");
        });
    });
    await new Promise<void>((resolve) => server.listen(options.port ?? 0, () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        requests,
        load: (name, ctx) => running.set(name, ctx),
        close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
}

/** Tool results sent since the latest user message. */
export function toolResults(body: any): string[] {
    const messages: any[] = body.messages ?? [];
    let last = -1;
    messages.forEach((m, i) => { if (m.role === "user") last = i; });
    return messages.slice(last + 1).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

/** The latest user question (without the workspace block the plugin adds). */
export function question(body: any): string {
    const users = (body.messages ?? []).filter((m: any) => m.role === "user");
    const c = users[users.length - 1]?.content;
    const text = typeof c === "string" ? c
        : Array.isArray(c) ? c.map((part: any) => (typeof part === "string" ? part : part?.text ?? "")).join("\n")
            : String(c ?? "");
    return text.split("User question: ").pop() ?? text;
}
