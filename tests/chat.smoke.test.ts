import { beforeEach, describe, expect, it, vi } from 'vitest';

const llmMock = {
  testConnection: vi.fn()
};

// Stands in for the Pi chat agent. Tests script it like a token stream:
// each chunk becomes a text event, exactly as the real agent emits them.
const agentMock = {
  send: vi.fn(),
  reset: vi.fn()
};

vi.mock('../src/main', () => ({
  default: class {}
}));

vi.mock('../src/services/LLMService', () => ({
  createLLMService: vi.fn(() => llmMock)
}));

import { ChatView } from '../src/views/ChatView';
import { WorkspaceLeaf } from 'obsidian';

function createPluginStub() {
  return {
    settings: {
      apiEndpoint: 'http://localhost:1234/v1/chat/completions',
      apiKey: '',
      systemPrompt: 'Be concise',
      model: undefined,
      contextNotesVisible: false
    },
    agentRuntime: { workspaceContext: () => '[Obsidian workspace]\nActive note: (none)' },
    createChatAgent: () => agentMock,
    saveSettings: vi.fn(async () => undefined)
  };
}

function createAppStub() {
  return {
    workspace: {
      openLinkText: vi.fn(),
      getLeavesOfType: vi.fn(() => []),
      getActiveViewOfType: vi.fn(() => null)
    },
    vault: {
      cachedRead: vi.fn(async () => ''),
      getMarkdownFiles: vi.fn(() => [])
    },
    metadataCache: {
      getFileCache: vi.fn(() => null)
    },
    setting: {
      open: vi.fn(),
      openTabById: vi.fn()
    }
  };
}

async function flushRenderTicks(iterations: number = 2): Promise<void> {
  for (let index = 0; index < iterations; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('Obsidian chat smoke test', () => {
  it('opens at once, with an empty chat, while the server check is still running', async () => {
    let answer: (result: { success: boolean }) => void = () => undefined;
    llmMock.testConnection.mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    const view = new ChatView(new WorkspaceLeaf(createAppStub()) as any, createPluginStub() as any);
    // Resolves although the server has not answered: Obsidian's startup waits on this.
    await view.onOpen();
    const text = () => view.containerEl.querySelector('.local-llm-message-content')?.textContent ?? '';
    expect(view.containerEl.querySelectorAll('.local-llm-message').length).toBe(0);
    expect(view.containerEl.querySelector('textarea.local-llm-input')).not.toBeNull();

    answer({ success: false });
    await view.welcomeReady;
    expect(text()).toContain('Welcome to Private AI');
    expect(view.containerEl.querySelectorAll('[data-message-id="welcome"]').length).toBe(1);
  });

  beforeEach(() => {
    llmMock.testConnection.mockReset();
    agentMock.send.mockReset();
  });

  it('opens chat view and renders ready state', async () => {
    llmMock.testConnection.mockResolvedValue({ success: true });

    const app = createAppStub();
    const leaf = new WorkspaceLeaf(app);
    const view = new ChatView(leaf as any, createPluginStub() as any);

    await view.onOpen();
    // onOpen does not wait for the server check; the greeting arrives right after.
    await view.welcomeReady;

    const content = view.containerEl.children[1].textContent ?? '';
    expect(content).not.toContain('Private AI chat');
    expect(view.containerEl.querySelector('.local-llm-chat-header h4')).toBeNull();
    expect(view.containerEl.querySelector('.local-llm-new-chat-button')).not.toBeNull();
    // Settings on the left, History and New chat on the right.
    const buttons = [...view.containerEl.querySelectorAll('.local-llm-header-buttons > button')].map((b) => b.className);
    expect(buttons).toEqual(['local-llm-settings-button', 'local-llm-history-button', 'local-llm-new-chat-button']);
    // A working server gets no greeting bubble; the hint lives in the message box.
    expect(content).not.toContain("What's on your mind?");
    expect(view.containerEl.querySelectorAll('.local-llm-message').length).toBe(0);
    expect(view.containerEl.querySelector('textarea.local-llm-input')?.getAttribute('placeholder')).toBe("What's on your mind?");
  });

  it('sends a prompt and streams assistant response', async () => {
    llmMock.testConnection.mockResolvedValue({ success: true });
    agentMock.send.mockImplementation(async (_message: string, onEvent: (event: any) => void) => {
      const callback = async (chunk: string, done: boolean) => { if (!done && chunk) onEvent({ type: 'text', delta: chunk }); };
      await callback('Hello', false);
      await callback(' from test', false);
      await callback('', true);
    });

    const app = createAppStub();
    const leaf = new WorkspaceLeaf(app);
    const view = new ChatView(leaf as any, createPluginStub() as any);

    await view.onOpen();

    const input = view.containerEl.querySelector('textarea') as HTMLTextAreaElement;
    const sendButton = view.containerEl.querySelector('.local-llm-send-button') as HTMLButtonElement;

    input.value = 'ping';
    sendButton.click();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rendered = view.containerEl.textContent ?? '';
    expect(rendered).toContain('ping');
    expect(rendered).toContain('Hello from test');
    expect(agentMock.send).toHaveBeenCalledTimes(1);

    // Only the user's message sits in a bubble; the reply is inline. Both get one copy button.
    const user = view.containerEl.querySelector('.local-llm-message-user') as HTMLElement;
    const assistant = view.containerEl.querySelector('.local-llm-message-assistant') as HTMLElement;
    expect(user.querySelector('.local-llm-message-bubble .local-llm-message-content')?.textContent).toBe('ping');
    expect(assistant.querySelector('.local-llm-message-bubble')).toBeNull();
    for (const message of [user, assistant]) {
      expect(message.querySelectorAll('.local-llm-message-actions .local-llm-copy-button').length).toBe(1);
      expect(message.querySelectorAll('button').length).toBe(1);
    }
  });

  it('streams think tags into collapsible thinking blocks without exposing raw tags', async () => {
    llmMock.testConnection.mockResolvedValue({ success: true });

    let releaseStepTwo: (() => void) | null = null;
    let releaseFinish: (() => void) | null = null;
    const stepTwoGate = new Promise<void>((resolve) => {
      releaseStepTwo = resolve;
    });
    const finishGate = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });

    agentMock.send.mockImplementation(async (_message: string, onEvent: (event: any) => void) => {
      const callback = async (chunk: string, done: boolean) => { if (!done && chunk) onEvent({ type: 'text', delta: chunk }); };
      await callback('<think>1. Analyze request\n2. Gather context', false);
      await stepTwoGate;
      await callback('\n3. Identify constraints\n4. Draft response\n5. Final pass', false);
      await finishGate;
      await callback('</think>Final answer', false);
      await callback('', true);
    });

    const app = createAppStub();
    const leaf = new WorkspaceLeaf(app);
    const view = new ChatView(leaf as any, createPluginStub() as any);

    await view.onOpen();

    const input = view.containerEl.querySelector('textarea') as HTMLTextAreaElement;
    const sendButton = view.containerEl.querySelector('.local-llm-send-button') as HTMLButtonElement;
    input.value = 'test';
    sendButton.click();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const inProgressText = view.containerEl.textContent ?? '';
    expect(inProgressText).toContain('Thinking...');
    expect(inProgressText).not.toContain('<think>');
    let previewLines = Array.from(view.containerEl.querySelectorAll('.local-llm-thinking-preview-line'));
    expect(previewLines.length).toBe(2);
    let previewText = (view.containerEl.querySelector('.local-llm-thinking-preview-markdown')?.textContent ?? '').trim();
    expect(previewText).toContain('Analyze request');
    expect(previewText).toContain('Gather context');
    expect(view.containerEl.querySelectorAll('.local-llm-thinking-summary').length).toBe(1);
    const streamingToggle = view.containerEl.querySelector('.local-llm-thinking-toggle') as HTMLButtonElement;
    expect(streamingToggle).toBeTruthy();
    expect(streamingToggle.textContent ?? '').toContain('Hide');

    releaseStepTwo?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    previewLines = Array.from(view.containerEl.querySelectorAll('.local-llm-thinking-preview-line'));
    expect(previewLines.length).toBe(5);
    previewText = (view.containerEl.querySelector('.local-llm-thinking-preview-markdown')?.textContent ?? '').trim();
    expect(previewText).toContain('Analyze request');
    expect(previewText).toContain('Gather context');
    expect(previewText).toContain('Final pass');

    releaseFinish?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rendered = view.containerEl.textContent ?? '';
    expect(rendered).toContain('Final answer');
    expect(rendered).toContain('Thought process');
    expect(rendered).not.toContain('<think>');
    expect(rendered).not.toContain('</think>');
    const completedToggle = view.containerEl.querySelector('.local-llm-thinking-toggle') as HTMLButtonElement;
    expect(completedToggle).toBeTruthy();
    expect(completedToggle.textContent ?? '').toContain('Show');
    const collapsedPreview = view.containerEl.querySelector('.local-llm-thinking-preview-markdown') as HTMLElement;
    expect(collapsedPreview).toBeTruthy();
    expect(collapsedPreview.classList.contains('local-llm-thinking-preview-hidden')).toBe(true);

    completedToggle.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reopenedToggle = view.containerEl.querySelector('.local-llm-thinking-toggle') as HTMLButtonElement;
    expect(reopenedToggle.textContent ?? '').toContain('Hide');
    const reopenedPreview = view.containerEl.querySelector('.local-llm-thinking-preview-markdown') as HTMLElement;
    expect(reopenedPreview.classList.contains('local-llm-thinking-preview-hidden')).toBe(false);
    expect(view.containerEl.querySelectorAll('.local-llm-thinking-preview-line').length).toBe(5);
  });

  it('keeps the thinking panel stable during streaming, with sticky scroll and responsive toggles', async () => {
    llmMock.testConnection.mockResolvedValue({ success: true });

    const chunkGates: Array<() => void> = [];
    const waitForChunkGate = () => new Promise<void>((resolve) => {
      chunkGates.push(resolve);
    });

    agentMock.send.mockImplementation(async (_message: string, onEvent: (event: any) => void) => {
      const callback = async (chunk: string, done: boolean) => { if (!done && chunk) onEvent({ type: 'text', delta: chunk }); };
      await callback('<think>1. Start', false);
      for (let step = 2; step <= 6; step++) {
        await waitForChunkGate();
        await callback(`\n${step}. Step ${step}`, false);
      }
      await waitForChunkGate();
      await callback('</think>Done', false);
      await callback('', true);
    });

    const app = createAppStub();
    const leaf = new WorkspaceLeaf(app);
    const view = new ChatView(leaf as any, createPluginStub() as any);

    await view.onOpen();

    const input = view.containerEl.querySelector('textarea') as HTMLTextAreaElement;
    const sendButton = view.containerEl.querySelector('.local-llm-send-button') as HTMLButtonElement;
    input.value = 'stream stress';
    sendButton.click();
    await flushRenderTicks(3);

    const toggle = view.containerEl.querySelector('.local-llm-thinking-toggle') as HTMLButtonElement;
    const preview = view.containerEl.querySelector('.local-llm-thinking-preview-markdown') as HTMLElement;
    expect(toggle).toBeTruthy();
    expect(preview).toBeTruthy();

    let scrollTopValue = 0;
    let scrollHeightValue = 160;
    Object.defineProperty(preview, 'clientHeight', {
      configurable: true,
      get: () => 40
    });
    Object.defineProperty(preview, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeightValue
    });
    Object.defineProperty(preview, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      }
    });

    scrollTopValue = scrollHeightValue;
    preview.dispatchEvent(new Event('scroll'));
    scrollHeightValue += 40;
    const firstGate = chunkGates.shift();
    expect(firstGate).toBeTruthy();
    firstGate?.();
    await flushRenderTicks(2);
    expect(scrollTopValue).toBe(scrollHeightValue);

    scrollTopValue = 10;
    preview.dispatchEvent(new Event('scroll'));
    scrollHeightValue += 40;
    const secondGate = chunkGates.shift();
    expect(secondGate).toBeTruthy();
    secondGate?.();
    await flushRenderTicks(2);
    expect(scrollTopValue).toBe(10);

    for (let index = 0; index < 3; index++) {
      const before = toggle.textContent ?? '';
      toggle.click();
      await flushRenderTicks(1);
      expect(toggle.textContent ?? '').not.toBe(before);

      scrollHeightValue += 40;
      const gate = chunkGates.shift();
      expect(gate).toBeTruthy();
      gate?.();
      await flushRenderTicks(2);

      const liveToggle = view.containerEl.querySelector('.local-llm-thinking-toggle') as HTMLButtonElement;
      const livePreview = view.containerEl.querySelector('.local-llm-thinking-preview-markdown') as HTMLElement;
      expect(liveToggle).toBe(toggle);
      expect(livePreview).toBe(preview);
    }

    const finalGate = chunkGates.shift();
    expect(finalGate).toBeTruthy();
    finalGate?.();
    await flushRenderTicks(3);

    const rendered = view.containerEl.textContent ?? '';
    expect(rendered).toContain('Done');
    expect(rendered).not.toContain('<think>');
    expect(rendered).not.toContain('</think>');
  });
});
