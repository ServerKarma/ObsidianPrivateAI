import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, FauxProviderRegistration } from '@mariozechner/pi-ai';

// End-to-end through the real stack: ChatView -> Pi agent loop -> built-in MCP server
// -> vault tools -> BM25 search over the files. Only the language model is scripted
// (Pi's faux provider), and Obsidian's API is stubbed.

const llmMock = {
  testConnection: vi.fn()
};

vi.mock('../src/main', () => ({
  default: class {}
}));

vi.mock('../src/services/LLMService', () => ({
  createLLMService: vi.fn(() => llmMock)
}));

import { ChatView } from '../src/views/ChatView';
import { WorkspaceLeaf, TFile } from 'obsidian';
import { PiChatAgent } from '../src/agent/pi/PiChatAgent';
import { loadMcpTools } from '../src/agent/pi/mcpTools';
import { createVaultTools, describeWorkspace } from '../src/agent/tools/vaultTools';
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

function createPluginStub(
  files: Array<{ path: string; content: string }>,
  workspace: { active?: string; open?: string[] } = {},
) {
  const vault = new InMemoryVault(Object.fromEntries(files.map((f) => [f.path, f.content])));
  vault.active = workspace.active ?? null;
  vault.open = workspace.open ?? [];
  const search = new VaultSearch(vault);
  const server = createVaultMcpServer(createVaultTools({ vault, search, confirm: async () => true }), { version: 'test', allowWrites: () => true });
  const clientPromise = connectInProcess(server);
  const settings = {
    apiEndpoint: 'http://localhost:1234/v1/chat/completions',
    apiKey: '',
    maxTokens: 2048,
    temperature: 0.7,
    systemPrompt: 'Be concise',
    model: 'test-model',
    maxToolRounds: 5,
    contextNotesVisible: false,
  };
  return {
    settings,
    agentRuntime: { search, imageCache: { count: 0 }, workspaceContext: () => `[Obsidian workspace]\n${describeWorkspace(vault, search)}` },
    createChatAgent: () => new PiChatAgent({
      settings: () => settings,
      loadTools: async () => loadMcpTools(await clientPromise),
      buildModel: () => faux.getModel(),
    }),
    saveSettings: vi.fn(async () => undefined),
  };
}

function createAppStub(files: Array<{ path: string; basename: string; extension: string; content: string }>) {
  // Real TFile instances, so the chat can list the notes the agent read.
  const tfiles = files.map((f) => Object.assign(new TFile(), { path: f.path, basename: f.basename, extension: f.extension }));
  return {
    workspace: {
      openLinkText: vi.fn(),
      getLeavesOfType: vi.fn(() => []),
      getActiveViewOfType: vi.fn(() => null),
    },
    vault: {
      cachedRead: vi.fn(async () => ''),
      getMarkdownFiles: vi.fn(() => tfiles),
      getAbstractFileByPath: vi.fn((path: string) => tfiles.find((f) => f.path === path) ?? null),
    },
    metadataCache: { getFileCache: vi.fn(() => null) },
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

  async function ask(view: ChatView, question: string): Promise<void> {
    const input = view.containerEl.querySelector('textarea') as HTMLTextAreaElement;
    input.value = question;
    (view.containerEl.querySelector('.local-llm-send-button') as HTMLButtonElement).click();
    await flushRenderTicks(2);
    await waitFor(() => isIdle(view));
  }

  it('tells the model which note is open, and it reads that note for "this note" questions', async () => {
    let firstUserMessage = '';
    let readResult = '';
    faux.setResponses([
      (context) => {
        firstUserMessage = JSON.stringify(context.messages[0]);
        return fauxAssistantMessage([fauxToolCall('read_note', { path: QUANTUM_ARTICLE.path })], { stopReason: 'toolUse' });
      },
      (context) => {
        readResult = JSON.stringify(context.messages.filter((m) => m.role === 'toolResult')[0]);
        return fauxAssistantMessage(fauxText('This note covers a 1000-qubit processor with error correction.'));
      },
    ]);

    const files = [QUANTUM_ARTICLE, RECIPE_ARTICLE];
    const view = new ChatView(
      new WorkspaceLeaf(createAppStub(files)) as any,
      createPluginStub(files, { active: QUANTUM_ARTICLE.path, open: [QUANTUM_ARTICLE.path, RECIPE_ARTICLE.path] }) as any,
    );
    await view.onOpen();
    await ask(view, 'summarize this note');

    // Paths only: the model decides what to read.
    expect(firstUserMessage).toContain('[Obsidian workspace]');
    expect(firstUserMessage).toContain(`Active note: ${QUANTUM_ARTICLE.path}`);
    expect(firstUserMessage).toContain(`- ${RECIPE_ARTICLE.path}`);
    expect(firstUserMessage).toContain('User question: summarize this note');
    expect(firstUserMessage).not.toContain('1000-qubit');
    expect(readResult).toContain('1000-qubit quantum processor');

    const rendered = view.containerEl.textContent ?? '';
    expect(rendered).toContain('1000-qubit processor with error correction');
    expect(rendered).toContain('Read 1 note');
    expect(rendered).not.toContain('relevant');
    expect(view.containerEl.querySelector('.local-llm-context-mode-container')).toBeNull();
  });

  it('searches the whole vault for other questions, with BM25', async () => {
    let searchResult = '';
    let firstUserMessage = '';
    let toolNames: string[] = [];
    faux.setResponses([
      (context) => {
        firstUserMessage = JSON.stringify(context.messages[0]);
        toolNames = (context.tools ?? []).map((t) => t.name);
        return fauxAssistantMessage([fauxToolCall('search_notes', { query: 'xylophone-paradox-7 superconductor' })], { stopReason: 'toolUse' });
      },
      (context) => {
        searchResult = JSON.stringify(context.messages.filter((m) => m.role === 'toolResult')[0]);
        return fauxAssistantMessage([fauxToolCall('read_note', { path: 'research/superconductor-breakthrough.md' })], { stopReason: 'toolUse' });
      },
      fauxAssistantMessage(fauxText('The xylophone-paradox-7 discovery appears in the superconductor note about LK-99.')),
    ]);

    const view = new ChatView(new WorkspaceLeaf(createAppStub(HAYSTACK_FILES)) as any, createPluginStub(HAYSTACK_FILES) as any);
    await view.onOpen();
    // No indexing or search status line in the chat.
    expect(view.containerEl.querySelector('.local-llm-rag-status-area')).toBeNull();
    await ask(view, 'xylophone-paradox-7 superconductor');

    expect(toolNames).toContain('search_notes');
    expect(toolNames).toContain('read_note');
    expect(firstUserMessage).toContain('Active note: (none)');
    expect(searchResult).toContain('research/superconductor-breakthrough.md');
    expect(searchResult).not.toContain('grocery-list');
    expect(searchResult).not.toContain('travel-plans');

    const rendered = view.containerEl.textContent ?? '';
    expect(rendered).toContain('xylophone-paradox-7 discovery');
    expect(rendered).toContain('Thought process');
    expect(rendered).toContain('Read 1 note');
  });
});
