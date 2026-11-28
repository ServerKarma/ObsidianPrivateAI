import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOllamaShowCache, LLMService, numCtxFromParameters, OLLAMA_DEFAULT_CONTEXT } from '../src/services/LLMService';
import { guessServerType, isPresetEndpoint, serverProfile } from '../src/services/localServers';
import { noModelsMessage, noToolSupportMessage, serverOfflineMessage, setupInstructions, smallContextMessage } from '../src/services/modelGuidance';

declare global {
  var __requestUrlMock: ReturnType<typeof vi.fn>;
}

type Route = (body: any) => { status: number; json: unknown } | undefined;

/** Answers requestUrl by path, like a local server would. Unknown paths get a 404. */
function serve(routes: Record<string, Route | object>) {
  global.__requestUrlMock.mockImplementation(async ({ url, body }: { url: string; body?: string }) => {
    const path = new URL(url).pathname;
    const route = routes[`${path}`];
    if (route === undefined) return { status: 404, json: null, text: 'not found' };
    const answer = typeof route === 'function' ? (route as Route)(body ? JSON.parse(body) : undefined) : { status: 200, json: route };
    return answer ?? { status: 404, json: null, text: 'not found' };
  });
}

const ollama = (model?: string) =>
  new LLMService({ apiEndpoint: 'http://localhost:11434/v1/chat/completions', serverType: 'ollama', model });

describe('Ollama', () => {
  beforeEach(() => {
    clearOllamaShowCache();
    global.__requestUrlMock.mockReset();
  });

  const show: Record<string, object> = {
    'gemma4:e4b': { capabilities: ['completion', 'tools', 'vision'], parameters: 'temperature 1' },
    'gemma4:e2b': { capabilities: ['completion', 'tools', 'vision'], parameters: 'num_ctx 16384\ntemperature 1' },
    'llama2:7b': { capabilities: ['completion'] },
    'nomic-embed-text:latest': { capabilities: ['embedding'] },
  };
  const tags = {
    models: [
      { name: 'llama2:7b', model: 'llama2:7b', size: 1_000, digest: 'a' },
      { name: 'gemma4:e4b', model: 'gemma4:e4b', size: 9_000, digest: 'b' },
      { name: 'gemma4:e2b', model: 'gemma4:e2b', size: 5_000, digest: 'c' },
      { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 100, digest: 'd' },
    ],
  };
  const routes = (running: object[] = []) => ({
    '/api/tags': tags,
    '/api/ps': { models: running },
    '/api/show': (body: any) => (show[body.model] ? { status: 200, json: show[body.model] } : undefined),
  });

  it('reads tool and vision support from /api/show and the loaded context from /api/ps', async () => {
    serve(routes([{ name: 'gemma4:e4b', model: 'gemma4:e4b', context_length: 32768 }]));
    expect(await ollama().getServerStatus()).toEqual({
      state: 'ready',
      model: { id: 'gemma4:e4b', loaded: true, toolUse: true, vision: true, contextLength: 32768 },
    });
  });

  it('picks the smallest model that can use tools when none is loaded, skipping embedding models', async () => {
    serve(routes());
    const status = await ollama().getServerStatus();
    // llama2 is smaller but has no tools; the embedding model is not a chat model.
    expect(status).toMatchObject({ state: 'ready', model: { id: 'gemma4:e2b', loaded: false, toolUse: true } });
    // Not loaded: the Modelfile's num_ctx is what Ollama will load it with.
    expect((status as any).model.contextLength).toBe(16384);
  });

  it('assumes Ollama\'s smallest default context for an unloaded model without num_ctx', async () => {
    serve(routes());
    const status = await ollama('gemma4:e4b').getServerStatus();
    expect((status as any).model).toMatchObject({ id: 'gemma4:e4b', loaded: false, contextLength: OLLAMA_DEFAULT_CONTEXT });
  });

  it('reports a configured model that cannot use tools', async () => {
    serve(routes());
    expect((await ollama('llama2:7b').getServerStatus() as any).model).toMatchObject({ id: 'llama2:7b', toolUse: false, vision: false });
  });

  it('says no-models when Ollama has nothing downloaded', async () => {
    serve({ '/api/tags': { models: [] }, '/api/ps': { models: [] } });
    expect(await ollama().getServerStatus()).toEqual({ state: 'no-models' });
  });

  it('says offline when nothing answers', async () => {
    global.__requestUrlMock.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
    expect(await ollama().getServerStatus()).toEqual({ state: 'offline' });
  });

  it('asks /api/show once per model version', async () => {
    serve(routes());
    await ollama().getServerStatus();
    await ollama().getServerStatus();
    const shows = global.__requestUrlMock.mock.calls.filter(([r]) => r.url.endsWith('/api/show'));
    expect(shows).toHaveLength(tags.models.length);
    expect(shows[0][0].method).toBe('POST');
  });

  it('falls back to the OpenAI model list when /api/tags is missing', async () => {
    serve({ '/v1/models': { object: 'list', data: [{ id: 'qwen3:8b' }] } });
    expect(await ollama().getServerStatus()).toEqual({
      state: 'ready',
      model: { id: 'qwen3:8b', loaded: false, vision: undefined, toolUse: undefined, contextLength: undefined },
    });
  });

  it('lists model names for the settings dropdown', async () => {
    serve(routes());
    expect(await ollama().getAvailableModels()).toEqual(['llama2:7b', 'gemma4:e4b', 'gemma4:e2b', 'nomic-embed-text:latest']);
  });

  it('parses num_ctx from Modelfile parameters', () => {
    expect(numCtxFromParameters('num_ctx 8192')).toBe(8192);
    expect(numCtxFromParameters('stop "<eos>"\nnum_ctx    65536\n')).toBe(65536);
    expect(numCtxFromParameters('temperature 0.7')).toBeUndefined();
    expect(numCtxFromParameters(undefined)).toBeUndefined();
  });
});

describe('llama.cpp', () => {
  beforeEach(() => {
    global.__requestUrlMock.mockReset();
  });

  it('treats the one served model as loaded and reads its context from /props', async () => {
    serve({
      '/v1/models': { object: 'list', data: [{ id: 'gemma-4-e4b-it-Q4_K_M.gguf' }] },
      '/props': { default_generation_settings: { n_ctx: 32768 }, modalities: { vision: true } },
    });
    const service = new LLMService({ apiEndpoint: 'http://localhost:8080/v1/chat/completions', serverType: 'llamacpp' });
    expect(await service.getServerStatus()).toEqual({
      state: 'ready',
      model: { id: 'gemma-4-e4b-it-Q4_K_M.gguf', loaded: true, vision: true, toolUse: undefined, contextLength: 32768 },
    });
    // LM Studio's REST path is not tried for other servers.
    expect(global.__requestUrlMock.mock.calls.some(([r]) => r.url.includes('/api/v1/models'))).toBe(false);
  });
});

describe('server choice', () => {
  it('guesses the server of an endpoint saved before the setting existed', () => {
    expect(guessServerType('http://localhost:1234/v1/chat/completions')).toBe('lmstudio');
    expect(guessServerType('http://127.0.0.1:11434/v1/chat/completions')).toBe('ollama');
    expect(guessServerType('http://localhost:1337/v1/chat/completions')).toBe('jan');
    expect(guessServerType('http://localhost:8080/v1/chat/completions')).toBe('llamacpp');
    expect(guessServerType('not a url')).toBe('lmstudio');
  });

  it('only replaces an endpoint the user has not customised', () => {
    expect(isPresetEndpoint('http://localhost:1234/v1/chat/completions')).toBe(true);
    expect(isPresetEndpoint('http://192.168.1.5:1234/v1/chat/completions')).toBe(false);
  });

  it('defaults every server to this computer', () => {
    for (const type of ['lmstudio', 'ollama', 'llamacpp', 'jan', 'openai'] as const) {
      expect(new URL(serverProfile(type).defaultEndpoint).hostname).toBe('localhost');
    }
  });
});

describe('guidance per server', () => {
  it('keeps the LM Studio wording', () => {
    expect(serverOfflineMessage('http://localhost:1234/v1/chat/completions')).toContain("Can't reach LM Studio");
    expect(noModelsMessage()).toContain('LM Studio is running, but it has no chat model downloaded');
    expect(setupInstructions()).toContain('Download and install LM Studio');
  });

  it('gives Ollama users Ollama steps and model tags', () => {
    expect(serverOfflineMessage('http://localhost:11434/v1/chat/completions', 'ollama')).toContain("Can't reach Ollama");
    expect(noModelsMessage('ollama')).toContain('`gemma4:e4b`');
    expect(noModelsMessage('ollama')).toContain('ollama pull');
    expect(noToolSupportMessage('llama2:7b', 'ollama')).toContain('ollama pull');
    expect(setupInstructions('ollama')).not.toContain('LM Studio');
    expect(smallContextMessage('gemma4:e4b', 4096, 'ollama')).toContain('4,096-token');
  });

  it('names no app for a generic server', () => {
    expect(noModelsMessage('openai')).toMatch(/^## .*\n\nYour local server is running/);
  });
});
