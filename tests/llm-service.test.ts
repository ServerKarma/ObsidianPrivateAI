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
