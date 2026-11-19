/**
 * Drives a real LM Studio through its REST API, for the live evals.
 * Set LMSTUDIO_URL if the server isn't at http://localhost:1234.
 */
export const LMSTUDIO_URL = (process.env.LMSTUDIO_URL ?? "http://localhost:1234").replace(/\/+$/, "");
export const LMSTUDIO_CHAT_ENDPOINT = `${LMSTUDIO_URL}/v1/chat/completions`;

export interface LiveModel {
    key: string;
    type: "llm" | "embedding";
    sizeBytes: number;
    vision: boolean | undefined;
    toolUse: boolean | undefined;
    loadedInstances: string[];
}

async function call(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${LMSTUDIO_URL}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`LM Studio ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
}

export async function isRunning(): Promise<boolean> {
    try {
        await call("/api/v1/models");
        return true;
    } catch {
        return false;
    }
}

export async function listModels(): Promise<LiveModel[]> {
    const payload = await call("/api/v1/models");
    return (payload.models ?? []).map((m: any) => ({
        key: m.key,
        type: m.type,
        sizeBytes: m.size_bytes ?? 0,
        vision: m.capabilities?.vision,
        toolUse: m.capabilities?.trained_for_tool_use,
        loadedInstances: (m.loaded_instances ?? []).map((i: any) => i.id),
    }));
}

export const chatModels = async (): Promise<LiveModel[]> => (await listModels()).filter((m) => m.type === "llm");

export const loadedChatModels = async (): Promise<LiveModel[]> => (await chatModels()).filter((m) => m.loadedInstances.length > 0);

export async function unloadAll(): Promise<void> {
    for (const model of await listModels()) {
        for (const instance of model.loadedInstances) await call("/api/v1/models/unload", { instance_id: instance });
    }
}

export async function load(key: string): Promise<void> {
    await call("/api/v1/models/load", { model: key });
}

/** Leaves exactly this model loaded. */
export async function loadOnly(key: string): Promise<void> {
    await unloadAll();
    await load(key);
}

/** Puts back the models that were loaded before the suite touched anything. */
export async function restore(keys: string[]): Promise<void> {
    await unloadAll();
    for (const key of keys) await load(key);
}
