import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { FakeReply } from "./fakeLmStudio";

/**
 * A scripted stand-in for Ollama: its native /api/tags, /api/ps and /api/show, and the
 * OpenAI-compatible /v1/chat/completions, streamed the way Ollama streams (each tool call
 * whole in one chunk). Like Ollama's defaults, it only allows browser requests from local
 * pages and app:// origins, so this also checks that Obsidian's origin gets through.
 */
export interface FakeOllamaModel {
    name: string;
    size: number;
    capabilities: string[];
    /** Modelfile parameters text, e.g. "num_ctx 16384". */
    parameters?: string;
}

export interface FakeOllama {
    url: string;
    requests: any[];
    /** Marks a model as in memory with this context, as /api/ps reports it. */
    load(name: string, contextLength: number): void;
    close(): Promise<void>;
}

const allowedOrigin = (origin: string | undefined): boolean =>
    !origin || /^app:\/\//.test(origin) || /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(origin);

export async function startFakeOllama(models: FakeOllamaModel[], respond: (body: any) => FakeReply): Promise<FakeOllama> {
    const requests: any[] = [];
    const running = new Map<string, number>();
    let callCounter = 0;
    const server = http.createServer((req, res) => {
        const origin = req.headers.origin;
        if (!allowedOrigin(origin)) {
            res.writeHead(403);
            res.end();
            return;
        }
        const cors = origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } : {};
        const json = (status: number, value: unknown) => {
            res.writeHead(status, { ...cors, "Content-Type": "application/json" });
            res.end(JSON.stringify(value));
        };
        if (req.method === "OPTIONS") {
            res.writeHead(204, cors);
            res.end();
            return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : {};
            const path = (req.url ?? "").split("?")[0];
            if (path === "/api/tags") return json(200, { models: models.map((m) => ({ name: m.name, model: m.name, size: m.size, digest: `sha-${m.name}` })) });
            if (path === "/api/ps") return json(200, { models: [...running].map(([name, context_length]) => ({ name, model: name, context_length })) });
            if (path === "/api/show") {
                const m = models.find((x) => x.name === body.model);
                return m ? json(200, { capabilities: m.capabilities, parameters: m.parameters ?? "" }) : json(404, { error: "not found" });
            }
            if (path === "/v1/models") return json(200, { object: "list", data: models.map((m) => ({ id: m.name, object: "model" })) });
            if (path !== "/v1/chat/completions") return json(404, { error: "not found" });

            requests.push(body);
            const reply = respond(body);
            const base = { id: "chatcmpl-ollama", object: "chat.completion.chunk", created: 0, model: body.model };
            if (!body.stream) {
                return json(200, { ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "text" in reply ? reply.text : "" }, finish_reason: "stop" }] });
            }
            res.writeHead(200, { ...cors, "Content-Type": "text/event-stream" });
            const send = (delta: object, finish: string | null = null) =>
                res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "", ...delta }, finish_reason: finish }] })}\n\n`);
            if ("toolCalls" in reply) {
                send({ tool_calls: reply.toolCalls.map((call, index) => ({ id: `call_${++callCounter}`, index, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
                send({}, "tool_calls");
            } else {
                for (const word of reply.text.split(/(?<= )/)) send({ content: word });
                send({}, "stop");
            }
            res.end("data: [DONE]\n\n");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        requests,
        load: (name, contextLength) => running.set(name, contextLength),
        close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
}
