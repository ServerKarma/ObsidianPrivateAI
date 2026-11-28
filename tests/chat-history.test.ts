import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatHistory, HistoryFileStore, SavedChat, chatTitle, newChatId, CHAT_RETENTION_CHOICES, retentionCutoff } from '../src/services/ChatHistory';

const llmMock = { testConnection: vi.fn(async () => ({ success: true })) };

vi.mock('../src/main', () => ({ default: class {} }));
vi.mock('../src/services/LLMService', () => ({ createLLMService: vi.fn(() => llmMock) }));

import { ChatView } from '../src/views/ChatView';
import { WorkspaceLeaf } from 'obsidian';

/** DataAdapter stand-in over a Map. */
class MemoryStore implements HistoryFileStore {
  files = new Map<string, string>();
  folders = new Set<string>();
  async exists(path: string) { return this.files.has(path) || this.folders.has(path); }
  async read(path: string) {
    const v = this.files.get(path);
    if (v === undefined) throw new Error('missing');
    return v;
  }
  async write(path: string, data: string) { this.files.set(path, data); }
  async remove(path: string) { this.files.delete(path); }
  async mkdir(path: string) { this.folders.add(path); }
  async list(path: string) {
    return { files: [...this.files.keys()].filter((f) => f.startsWith(path + '/')), folders: [] };
  }
}

function chat(id: string, updatedAt: string, title = id): SavedChat {
  return {
    version: 1, id, title, createdAt: updatedAt, updatedAt,
    messages: [{ id: '1', role: 'user', content: title, timestamp: updatedAt }],
    agentMessages: [],
  };
}

describe('ChatHistory', () => {
  it('saves, lists newest first, loads, deletes and prunes', async () => {
    const store = new MemoryStore();
    const history = new ChatHistory(store, 'plug/chats');
    await history.save(chat('a', '2026-01-01T00:00:00.000Z'));
    await history.save(chat('b', '2026-03-01T00:00:00.000Z'));
    await history.save(chat('c', '2026-02-01T00:00:00.000Z'));
    expect(store.folders.has('plug/chats')).toBe(true);
    expect((await history.list()).map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect((await history.load('c'))?.title).toBe('c');

    await history.delete('c');
    expect(await history.load('c')).toBeNull();
    await history.prune(1);
    expect((await history.list()).map((c) => c.id)).toEqual(['b']);
    expect(await history.clear()).toBe(1);
    expect(await history.list()).toEqual([]);
  });

  it('skips broken files and refuses ids that could leave the folder', async () => {
    const store = new MemoryStore();
    const history = new ChatHistory(store, 'chats');
    store.folders.add('chats');
    store.files.set('chats/bad.json', '{not json');
    store.files.set('chats/old.json', JSON.stringify({ version: 0 }));
    store.files.set('chats/notes.txt', 'x');
    expect(await history.list()).toEqual([]);
    await expect(history.load('../secret')).rejects.toThrow(/Invalid chat id/);
  });

  it('deletes chats older than the retention period, and keeps everything when indefinite', async () => {
    const store = new MemoryStore();
    const history = new ChatHistory(store, 'plug/chats');
    const now = new Date('2026-11-23T12:00:00Z');
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();
    const chat = (id: string, updatedAt: string): SavedChat => ({ version: 1, id, title: id, createdAt: updatedAt, updatedAt, messages: [], agentMessages: [] });
    await history.save(chat('today', daysAgo(0)));
    await history.save(chat('week', daysAgo(6)));
    await history.save(chat('month', daysAgo(29)));
    await history.save(chat('old', daysAgo(400)));

    expect(retentionCutoff(0, now)).toBeNull();
    expect(await history.removeOlderThan(0, now)).toBe(0);
    expect(await history.removeOlderThan(365, now)).toBe(1);
    expect((await history.list()).map((c) => c.id)).toEqual(['today', 'week', 'month']);
    expect(await history.removeOlderThan(7, now)).toBe(1);
    expect(await history.removeOlderThan(1, now)).toBe(1);
    expect((await history.list()).map((c) => c.id)).toEqual(['today']);
    expect(CHAT_RETENTION_CHOICES.map((c) => c.label)).toEqual(['1 day', '7 days', '30 days', '1 year', 'Indefinitely']);
  });

  it('titles a chat from the first question and makes sortable ids', () => {
    expect(chatTitle([])).toBe('New Chat');
    expect(chatTitle([{ id: '1', role: 'user', content: '  When did I\nreplace the heater? ', timestamp: '' }])).toBe('When did I replace the heater?');
    expect(chatTitle([{ id: '1', role: 'user', content: 'x'.repeat(100), timestamp: '' }])).toHaveLength(60);
    expect(newChatId(new Date('2026-11-20T01:02:03.456Z'))).toMatch(/^20261120T010203Z-[a-z0-9]+$/);
  });
});

describe('chat pane history', () => {
  let store: MemoryStore;
  let settings: Record<string, unknown>;

  /** A chat agent stand-in that keeps a transcript like PiChatAgent does. */
  function createAgent() {
    const agent = {
      messages: [] as unknown[],
      send: vi.fn(async (text: string, onEvent: (e: any) => void) => {
        agent.messages.push({ role: 'user', content: text });
        onEvent({ type: 'text', delta: `Answer to ${text}` });
        agent.messages.push({ role: 'assistant', content: `Answer to ${text}` });
      }),
      reset: vi.fn(() => { agent.messages = []; }),
      restore: vi.fn((m: unknown[]) => { agent.messages = [...m]; }),
    };
    return agent;
  }

  function createView(agent = createAgent()) {
    const chatHistory = new ChatHistory(store, 'plug/chats');
    const plugin = {
      settings,
      chatHistory,
      applyChatRetention: vi.fn(async () => chatHistory.removeOlderThan(Number(settings.chatRetentionDays ?? 0))),
      setChatRetention: vi.fn(async (days: number) => {
        settings.chatRetentionDays = days;
        return chatHistory.removeOlderThan(days);
      }),
      agentRuntime: { workspaceContext: () => '[Obsidian workspace]' },
      createChatAgent: () => agent,
      saveSettings: vi.fn(async () => undefined),
    };
    const app = { workspace: { openLinkText: vi.fn(), getLeavesOfType: vi.fn(() => []), getActiveViewOfType: vi.fn(() => null) } };
    return { view: new ChatView(new WorkspaceLeaf(app) as any, plugin as any), agent, plugin };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function ask(view: ChatView, text: string) {
    const input = view.containerEl.querySelector('textarea') as HTMLTextAreaElement;
    input.value = text;
    (view.containerEl.querySelector('.local-llm-send-button') as HTMLButtonElement).click();
    for (let i = 0; i < 6; i++) await tick();
    await view.historySaved;
  }

  const click = async (el: Element | null) => {
    (el as HTMLElement).click();
    for (let i = 0; i < 4; i++) await tick();
  };

  beforeEach(() => {
    store = new MemoryStore();
    settings = { apiEndpoint: 'http://localhost:1234/v1/chat/completions', saveChatHistory: true };
  });

  it('saves a chat after the answer and reopens it with the agent context in a new pane', async () => {
    const first = createView();
    await first.view.onOpen();
    await ask(first.view, 'When did I replace the water heater?');
    await ask(first.view, 'And the cost?');
    expect(store.files.size).toBe(1);
    const saved = JSON.parse([...store.files.values()][0]) as SavedChat;
    expect(saved.title).toBe('When did I replace the water heater?');
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(saved.agentMessages).toHaveLength(4);

    const second = createView();
    await second.view.onOpen();
    await click(second.view.containerEl.querySelector('.local-llm-history-button'));
    const items = second.view.containerEl.querySelectorAll('.local-llm-history-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('When did I replace the water heater?');
    expect(items[0].textContent).toContain('4 messages');
    expect(second.view.containerEl.querySelector('.local-llm-messages')?.classList.contains('local-llm-messages-hidden')).toBe(true);

    await click(items[0].querySelector('.local-llm-history-open'));
    expect(second.agent.restore).toHaveBeenCalledWith(saved.agentMessages);
    const shown = second.view.containerEl.querySelector('.local-llm-messages')?.textContent ?? '';
    expect(shown).toContain('And the cost?');
    expect(shown).toContain('Answer to And the cost?');
    expect(second.view.containerEl.querySelector('.local-llm-history')?.classList.contains('local-llm-history-hidden')).toBe(true);

    // Continuing writes to the same saved chat instead of a new one.
    await ask(second.view, 'Thanks');
    expect(store.files.size).toBe(1);
    expect((JSON.parse([...store.files.values()][0]) as SavedChat).messages).toHaveLength(6);
  });

  it('starts a separate saved chat after New chat, and deletes one from the list', async () => {
    const { view } = createView();
    await view.onOpen();
    await ask(view, 'first');
    await click(view.containerEl.querySelector('.local-llm-new-chat-button'));
    await ask(view, 'second');
    expect(store.files.size).toBe(2);

    await click(view.containerEl.querySelector('.local-llm-history-button'));
    const titles = () => [...view.containerEl.querySelectorAll('.local-llm-history-title')].map((e) => e.textContent);
    expect(titles().sort()).toEqual(['first', 'second']);
    const firstRow = [...view.containerEl.querySelectorAll('.local-llm-history-item')].find((r) => r.textContent?.includes('first'))!;
    await click(firstRow.querySelector('.local-llm-history-delete'));
    expect(titles()).toEqual(['second']);
    expect(store.files.size).toBe(1);
  });

  it('deletes every saved chat from the top of the list, after a second click', async () => {
    const { view } = createView();
    await view.onOpen();
    await ask(view, 'first');
    await click(view.containerEl.querySelector('.local-llm-new-chat-button'));
    await ask(view, 'second');
    expect(store.files.size).toBe(2);

    await click(view.containerEl.querySelector('.local-llm-history-button'));
    const clearAll = () => view.containerEl.querySelector('.local-llm-history-top .local-llm-history-clear') as HTMLButtonElement;
    // Next to Back to chat, so no scrolling is needed.
    expect(clearAll().nextElementSibling?.classList.contains('local-llm-history-back')).toBe(true);
    expect(clearAll().textContent).toBe('Delete all');
    await click(clearAll());
    expect(clearAll().textContent).toBe('Click again to delete');
    expect(store.files.size).toBe(2);
    await click(clearAll());
    expect(store.files.size).toBe(0);
    expect(view.containerEl.querySelector('.local-llm-history-empty')?.textContent).toContain('No saved chats yet');
    expect(view.containerEl.querySelector('.local-llm-history-clear')).toBeNull();

    // Like deleting one chat: if you keep talking in the chat on screen, it is saved again as a new chat.
    await click(view.containerEl.querySelector('.local-llm-history-back'));
    await ask(view, 'third');
    expect(store.files.size).toBe(1);
    expect((JSON.parse([...store.files.values()][0]) as SavedChat).messages.map((m) => m.content)).toContain('third');
  });

  it('changes how long chats are kept from the History list, removing older ones', async () => {
    const { view } = createView();
    await view.onOpen();
    await ask(view, 'recent');
    const old: SavedChat = { version: 1, id: '20240101T000000Z-aaaaaa', title: 'ancient', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', messages: [], agentMessages: [] };
    await new ChatHistory(store, 'plug/chats').save(old);

    await click(view.containerEl.querySelector('.local-llm-history-button'));
    const select = view.containerEl.querySelector('.local-llm-history-retention-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['1 day', '7 days', '30 days', '1 year', 'Indefinitely']);
    expect(select.value).toBe('0');
    expect(view.containerEl.querySelectorAll('.local-llm-history-item')).toHaveLength(2);

    select.value = '30';
    select.dispatchEvent(new Event('change'));
    for (let i = 0; i < 8; i++) await tick();
    expect(settings.chatRetentionDays).toBe(30);
    const titles = [...view.containerEl.querySelectorAll('.local-llm-history-title')].map((e) => e.textContent);
    expect(titles).toEqual(['recent']);
  });

  it('saves nothing when saving is off', async () => {
    settings.saveChatHistory = false;
    const { view } = createView();
    await view.onOpen();
    await ask(view, 'private question');
    expect(store.files.size).toBe(0);
    await click(view.containerEl.querySelector('.local-llm-history-button'));
    expect(view.containerEl.querySelector('.local-llm-history-empty')?.textContent).toContain('turned off');
  });
});
