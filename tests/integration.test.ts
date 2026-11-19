import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, FauxProviderRegistration } from '@mariozechner/pi-ai';

// End-to-end through the real stack: ChatView -> Pi agent loop -> built-in MCP server
// -> vault tools -> BM25 search over the files. Only the language model is scripted
// (Pi's faux provider), and Obsidian's API is stubbed.

const llmMock = {
  testConnection: vi.fn()
};

vi.mock('../src/main', () => ({
  ContextMode: {
    OPEN_NOTES: 'open-notes',
    SEARCH: 'search',
    NONE: 'none'
  },
  default: class {}
}));

vi.mock('../src/services/LLMService', () => ({
  createLLMService: vi.fn(() => llmMock)
}));

import { ChatView } from '../src/views/ChatView';
import { WorkspaceLeaf, MarkdownView } from 'obsidian';
import { PiChatAgent } from '../src/agent/pi/PiChatAgent';
import { loadMcpTools } from '../src/agent/pi/mcpTools';
import { createVaultTools } from '../src/agent/tools/vaultTools';
import { createVaultMcpServer } from '../src/agent/mcp/vaultMcpServer';
import { connectInProcess } from '../src/agent/mcp/inProcessClient';
import { VaultSearch } from '../src/agent/search/VaultSearch';
import { InMemoryVault } from './mocks/InMemoryVault';

// --- Test data ---

const QUANTUM_ARTICLE = {
  path: 'research/quantum-computing.md',
  basename: 'quantum-computing',
  extension: 'md',
  content: [
    '# Quantum Computing Advances',
    '',
    'Researchers at MIT demonstrated a 1000-qubit quantum processor capable of error correction.',
    'The breakthrough uses topological qubits that are inherently more stable than previous designs.',
    '',
    '## Key Findings',
    '- Error rates reduced by 99.7%',
    '- Coherence time extended to 10 milliseconds',
    '- First demonstration of fault-tolerant quantum computation',
  ].join('\n'),
};

const RECIPE_ARTICLE = {
  path: 'personal/sourdough-recipe.md',
  basename: 'sourdough-recipe',
  extension: 'md',
  content: [
    '# Sourdough Bread Recipe',
    '',
    'A simple sourdough recipe using a 72-hour cold ferment.',
    '',
    '## Ingredients',
    '- 500g bread flour',
    '- 350g water',
    '- 100g active starter',
    '- 10g salt',
  ].join('\n'),
};

const HAYSTACK_FILES = [
  {
    path: 'notes/meeting-notes.md',
    basename: 'meeting-notes',
    extension: 'md',
    content: '# Weekly Team Meeting\n\nDiscussed project timelines and resource allocation.\n\n## Action Items\n- Review Q3 budget\n- Update sprint backlog',
  },
  {
    path: 'notes/travel-plans.md',
    basename: 'travel-plans',
    extension: 'md',
    content: '# Summer Travel Plans\n\nLooking at flights to Barcelona for August.\n\n## Budget\n- Flights: $800\n- Hotel: $1200\n- Food: $500',
  },
  {
    path: 'research/superconductor-breakthrough.md',
    basename: 'superconductor-breakthrough',
    extension: 'md',
    content: '# Room Temperature Superconductor\n\nThe compound LK-99 containing lanarkite achieved superconductivity at 127 degrees Celsius and ambient pressure. This xylophone-paradox-7 discovery could revolutionize energy transmission.\n\n## Verification\n- Meissner effect confirmed\n- Resistance drops to zero at 127C\n- Crystal structure analyzed via X-ray diffraction',
  },
  {
    path: 'personal/grocery-list.md',
    basename: 'grocery-list',
    extension: 'md',
    content: '# Grocery List\n\n- Milk\n- Eggs\n- Bread\n- Apples\n- Chicken breast',
  },
];

// --- Helpers ---

let faux: FauxProviderRegistration;

function createPluginStub(contextMode: string, files: Array<{ path: string; content: string }>) {
  const vault = new InMemoryVault(Object.fromEntries(files.map((f) => [f.path, f.content])));
  const search = new VaultSearch(vault);
  const server = createVaultMcpServer(createVaultTools({ vault, search }), { version: 'test', allowWrites: () => true });
  const clientPromise = connectInProcess(server);
  const settings = {
    apiEndpoint: 'http://localhost:1234/v1/chat/completions',
    apiKey: '',
    maxTokens: 2048,
    temperature: 0.7,
    systemPrompt: 'Be concise',
    model: 'test-model',
    contextMode,
    maxToolRounds: 5,
    contextWindow: 32768,
    contextNotesVisible: false,
  };
  return {
    settings,
    agentRuntime: { search, imageCache: { count: 0 } },
    createChatAgent: () => new PiChatAgent({
      settings: () => settings,
      loadTools: async () => loadMcpTools(await clientPromise),
      buildModel: () => faux.getModel(),
    }),
    saveSettings: vi.fn(async () => undefined),
  };
}

function createAppStubForOpenNotes() {
  const quantumFile = { ...QUANTUM_ARTICLE };
  const recipeFile = { ...RECIPE_ARTICLE };

  const quantumLeaf = {
    view: Object.assign(new MarkdownView(quantumFile), { file: quantumFile }),
  };
  const recipeLeaf = {
    view: Object.assign(new MarkdownView(recipeFile), { file: recipeFile }),
  };

  return {
    workspace: {
      openLinkText: vi.fn(),
      getLeavesOfType: vi.fn((type: string) => {
        if (type === 'markdown') return [quantumLeaf, recipeLeaf];
        return [];
      }),
      getActiveViewOfType: vi.fn(() => null),
    },
    vault: {
      cachedRead: vi.fn(async (file: any) => {
        if (file.path === QUANTUM_ARTICLE.path) return QUANTUM_ARTICLE.content;
        if (file.path === RECIPE_ARTICLE.path) return RECIPE_ARTICLE.content;
        return '';
      }),
      getMarkdownFiles: vi.fn(() => []),
    },
    metadataCache: {
      getFileCache: vi.fn((file: any) => {
        if (file.path === QUANTUM_ARTICLE.path) {
          return {
            headings: [{ heading: 'Quantum Computing Advances', level: 1 }],
            tags: [{ tag: '#physics' }, { tag: '#quantum' }],
          };
        }
        if (file.path === RECIPE_ARTICLE.path) {
          return {
            headings: [{ heading: 'Sourdough Bread Recipe', level: 1 }],
            tags: [{ tag: '#cooking' }, { tag: '#bread' }],
          };
        }
        return null;
      }),
    },
    setting: { open: vi.fn(), openTabById: vi.fn() },
  };
}

function createAppStubForSearch() {
  const files = HAYSTACK_FILES.map((f) => ({ ...f }));

  return {
    workspace: {
      openLinkText: vi.fn(),
      getLeavesOfType: vi.fn(() => []),
      getActiveViewOfType: vi.fn(() => null),
    },
    vault: {
      cachedRead: vi.fn(async (file: any) => {
        const found = HAYSTACK_FILES.find((f) => f.path === file.path);
        return found ? found.content : '';
      }),
      getMarkdownFiles: vi.fn(() => files),
      getAbstractFileByPath: vi.fn((path: string) => files.find((f) => f.path === path) ?? null),
    },
    metadataCache: {
      getFileCache: vi.fn((file: any) => {
        if (file.path === 'research/superconductor-breakthrough.md') {
          return {
            headings: [{ heading: 'Room Temperature Superconductor', level: 1 }],
            tags: [{ tag: '#physics' }, { tag: '#superconductor' }],
          };
        }
        return { headings: [], tags: [] };
      }),
    },
    setting: { open: vi.fn(), openTabById: vi.fn() },
  };
}

async function flushRenderTicks(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the chat to finish');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const isIdle = (view: ChatView) => !(view as any).isStreaming && !(view as any).messages.some((m: any) => m.isStreaming);

// --- Tests ---

describe('Integration: chat view through the Pi agent and MCP tools', () => {
  beforeEach(() => {
    llmMock.testConnection.mockReset();
    llmMock.testConnection.mockResolvedValue({ success: true });
    faux = registerFauxProvider({ tokensPerSecond: 100000 });
  });

  afterEach(() => {
    faux.unregister();
  });

  it('OPEN_NOTES mode: open note content reaches the model and the answer renders', async () => {
    let firstUserMessage = '';
    faux.setResponses([
      (context) => {
        firstUserMessage = JSON.stringify(context.messages[0]);
        return fauxAssistantMessage(fauxText('The quantum article covers a 1000-qubit processor, and the recipe describes a 72-hour cold ferment.'));
      },
    ]);

    const app = createAppStubForOpenNotes();
    const view = new ChatView(new WorkspaceLeaf(app) as any, createPluginStub('open-notes', [QUANTUM_ARTICLE, RECIPE_ARTICLE]) as any);
    await view.onOpen();

    const input = view.containerEl.querySelector('textarea') as HTMLTextAreaElement;
    const sendButton = view.containerEl.querySelector('.local-llm-send-button') as HTMLButtonElement;
    input.value = 'summarize the current articles';
    sendButton.click();
    await flushRenderTicks(2);
    await waitFor(() => isIdle(view));

    expect(firstUserMessage).toContain('User question: summarize the current articles');
    expect(firstUserMessage).toContain('--- RELEVANT OBSIDIAN NOTES ---');
    expect(firstUserMessage).toContain('1000-qubit quantum processor');
    expect(firstUserMessage).toContain('500g bread flour');
    expect(firstUserMessage).toContain('Quantum Computing Advances');
    expect(firstUserMessage).toContain('Sourdough Bread Recipe');

    const rendered = view.containerEl.textContent ?? '';
    expect(rendered).toContain('1000-qubit processor');
    expect(rendered).toContain('72-hour cold ferment');
    expect(rendered).toContain('Used 2 notes as context');
  });

  it('SEARCH mode: the agent finds the needle note with BM25 search and reads it', async () => {
    let searchResult = '';
    let firstUserMessage = '';
    faux.setResponses([
      (context) => {
        firstUserMessage = JSON.stringify(context.messages[0]);
        return fauxAssistantMessage([fauxToolCall('search_notes', { query: 'xylophone-paradox-7 superconductor' })], { stopReason: 'toolUse' });
      },
      (context) => {
        searchResult = JSON.stringify(context.messages.filter((m) => m.role === 'toolResult')[0]);
        return fauxAssistantMessage([fauxToolCall('read_note', { path: 'research/superconductor-breakthrough.md' })], { stopReason: 'toolUse' });
      },
      fauxAssistantMessage(fauxText('The xylophone-paradox-7 discovery appears in the superconductor note about LK-99.')),
    ]);

    const app = createAppStubForSearch();
    const view = new ChatView(new WorkspaceLeaf(app) as any, createPluginStub('search', HAYSTACK_FILES) as any);
    await view.onOpen();
    expect(view.containerEl.textContent ?? '').toContain('The agent searches 4 notes');

    const input = view.containerEl.querySelector('textarea') as HTMLTextAreaElement;
    const sendButton = view.containerEl.querySelector('.local-llm-send-button') as HTMLButtonElement;
    input.value = 'xylophone-paradox-7 superconductor';
    sendButton.click();
    await flushRenderTicks(2);
    await waitFor(() => isIdle(view));

    // No notes are pasted into the prompt; the agent searches for itself.
    expect(firstUserMessage).not.toContain('RELEVANT OBSIDIAN NOTES');
    expect(searchResult).toContain('research/superconductor-breakthrough.md');
    expect(searchResult).not.toContain('grocery-list');
    expect(searchResult).not.toContain('travel-plans');

    const rendered = view.containerEl.textContent ?? '';
    expect(rendered).toContain('xylophone-paradox-7 discovery');
    expect(rendered).toContain('Thought process');
    expect(rendered).toContain('Used 1 note as context');
  });

  it('NONE mode: no tools and no notes are given to the model', async () => {
    let toolCount = -1;
    faux.setResponses([(context) => {
      toolCount = (context.tools ?? []).length;
      return fauxAssistantMessage(fauxText('Hello!'));
    }]);

    const app = createAppStubForSearch();
    const view = new ChatView(new WorkspaceLeaf(app) as any, createPluginStub('none', HAYSTACK_FILES) as any);
    await view.onOpen();
    const input = view.containerEl.querySelector('textarea') as HTMLTextAreaElement;
    input.value = 'hi';
    (view.containerEl.querySelector('.local-llm-send-button') as HTMLButtonElement).click();
    await flushRenderTicks(2);
    await waitFor(() => isIdle(view));

    expect(toolCount).toBe(0);
    expect(view.containerEl.textContent ?? '').toContain('Hello!');
  });
});
