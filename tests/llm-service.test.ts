import { describe, expect, it, vi } from 'vitest';
import { LLMService } from '../src/services/LLMService';

declare global {
  var __requestUrlMock: ReturnType<typeof vi.fn>;
}

describe('LLMService request contract', () => {
  it('sends model when configured and returns assistant text', async () => {
    global.__requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      text: '',
      json: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok'
            },
            finish_reason: 'stop'
          }
        ]
      }
    });

    const service = new LLMService({
      apiEndpoint: 'http://localhost:1234/v1/chat/completions',
      model: 'gemma-test'
    });

    const response = await service.sendMessage('hello');

    expect(response).toBe('ok');
    expect(global.__requestUrlMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(global.__requestUrlMock.mock.calls[0][0].body);
    expect(payload.model).toBe('gemma-test');
  });

  it('adds bearer authorization header when api key is configured', async () => {
    global.__requestUrlMock.mockResolvedValue({
      status: 200,
      headers: {},
      text: '',
      json: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok'
            },
            finish_reason: 'stop'
          }
        ]
      }
    });

    const service = new LLMService({
      apiEndpoint: 'http://localhost:1234/v1/chat/completions',
      apiKey: 'secret-key'
    });

    await service.sendMessage('hello');

    const requestArgs = global.__requestUrlMock.mock.calls[0][0];
    expect(requestArgs.headers.Authorization).toBe('Bearer secret-key');
  });
});

describe('LLMService default chat model', () => {
  const service = () => new LLMService({ apiEndpoint: 'http://localhost:1234/v1/chat/completions' });

  it('prefers the model already loaded in LM Studio over the first one listed', async () => {
    global.__requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        models: [
          { type: 'llm', key: 'qwen/first-listed', loaded_instances: [] },
          { type: 'embedding', key: 'text-embedding-loaded', loaded_instances: [{ id: 'text-embedding-loaded' }] },
          { type: 'llm', key: 'google/gemma-loaded', loaded_instances: [{ id: 'google/gemma-loaded' }] }
        ]
      }
    });

    expect(await service().getDefaultChatModel()).toBe('google/gemma-loaded');
  });

  it('falls back to the first chat model when none is loaded', async () => {
    global.__requestUrlMock.mockResolvedValue({
      status: 200,
      json: {
        models: [
          { type: 'embedding', key: 'text-embedding-a', loaded_instances: [] },
          { type: 'llm', key: 'qwen/first-listed', loaded_instances: [] },
          { type: 'llm', key: 'google/gemma', loaded_instances: [] }
        ]
      }
    });

    expect(await service().getDefaultChatModel()).toBe('qwen/first-listed');
  });
});

describe('LLMService server status', () => {
  const service = (model?: string) => new LLMService({ apiEndpoint: 'http://localhost:1234/v1/chat/completions', model });
  const lmStudio = (models: object[]) => global.__requestUrlMock.mockResolvedValue({ status: 200, json: { models } });
  const llm = (key: string, sizeBytes: number, caps: object | null, loaded = false) => ({
    type: 'llm', key, size_bytes: sizeBytes, capabilities: caps, loaded_instances: loaded ? [{ id: key }] : []
  });

  it('is offline when nothing answers', async () => {
    global.__requestUrlMock.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
    expect(await service().getServerStatus()).toEqual({ state: 'offline' });
  });

  it('is unknown, not offline, when a server answers but cannot list models', async () => {
    global.__requestUrlMock.mockResolvedValue({ status: 404, json: { error: 'not found' } });
    expect(await service().getServerStatus()).toEqual({ state: 'unknown' });
    global.__requestUrlMock.mockRejectedValue(Object.assign(new Error('Request failed, status 404'), { status: 404 }));
    expect(await service().getServerStatus()).toEqual({ state: 'unknown' });
  });

  it('has no models when nothing or only embedding models are downloaded', async () => {
    lmStudio([]);
    expect(await service().getServerStatus()).toEqual({ state: 'no-models' });
    lmStudio([{ type: 'embedding', key: 'text-embedding-a', loaded_instances: [] }]);
    expect(await service('some/model').getServerStatus()).toEqual({ state: 'no-models' });
  });

  it('reports the loaded model and what it can do', async () => {
    lmStudio([
      llm('small/tools', 1, { vision: true, trained_for_tool_use: true }),
      llm('loaded/no-tools', 9, { vision: true, trained_for_tool_use: false }, true)
    ]);
    expect(await service().getServerStatus()).toEqual({
      state: 'ready',
      model: { id: 'loaded/no-tools', loaded: true, vision: true, toolUse: false }
    });
  });

  it('prefers a loaded model that can do what is needed', async () => {
    lmStudio([
      llm('loaded/text-only', 1, { vision: false, trained_for_tool_use: true }, true),
      llm('loaded/vision', 9, { vision: true, trained_for_tool_use: true }, true)
    ]);
    expect((await service().getServerStatus('vision') as any).model.id).toBe('loaded/vision');
    expect((await service().getServerStatus('tools') as any).model.id).toBe('loaded/text-only');
  });

  it('picks the smallest capable model when none is loaded', async () => {
    lmStudio([
      llm('big/tools', 40, { vision: true, trained_for_tool_use: true }),
      llm('tiny/no-tools', 1, { vision: false, trained_for_tool_use: false }),
      llm('small/tools', 5, { vision: true, trained_for_tool_use: true })
    ]);
    expect(await service().getServerStatus()).toEqual({
      state: 'ready',
      model: { id: 'small/tools', loaded: false, vision: true, toolUse: true }
    });
    expect(await service().getDefaultChatModel()).toBe('small/tools');
  });

  it('uses the configured model, with its capabilities when the server knows it', async () => {
    lmStudio([llm('a/tools', 1, { vision: true, trained_for_tool_use: true }, true), llm('b/no-tools', 2, { vision: false, trained_for_tool_use: false })]);
    expect((await service('b/no-tools').getServerStatus() as any).model).toEqual({ id: 'b/no-tools', loaded: false, vision: false, toolUse: false });
    expect((await service('not/listed').getServerStatus() as any).model).toEqual({ id: 'not/listed', loaded: false });
  });

  it('leaves capabilities unknown for servers that do not report them', async () => {
    global.__requestUrlMock.mockResolvedValue({ status: 200, json: { data: [{ id: 'llama3' }] } });
    expect(await service().getServerStatus()).toEqual({
      state: 'ready',
      model: { id: 'llama3', loaded: false, vision: undefined, toolUse: undefined }
    });
  });
});
