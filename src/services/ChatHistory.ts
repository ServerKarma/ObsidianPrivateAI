/**
 * Saved chats, one JSON file per chat in the plugin's own folder
 * (<vault>/.obsidian/plugins/private-ai/chats/). They are kept out of the
 * notes on purpose: the agent can't search them, they don't show up in the
 * file explorer, and nothing leaves the device.
 */

/** The subset of Obsidian's DataAdapter the history needs (app.vault.adapter fits). */
export interface HistoryFileStore {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

/** One message as the chat pane shows it. */
export interface SavedChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	/** ISO time. */
	timestamp: string;
	usedNotes?: Array<{ title: string; path: string }>;
	thinkingBlocks?: string[];
}

export interface SavedChat {
	version: 1;
	id: string;
	title: string;
	/** ISO times. */
	createdAt: string;
	updatedAt: string;
	messages: SavedChatMessage[];
	/** The agent's own transcript (including tool calls), so a resumed chat continues with full context. */
	agentMessages: unknown[];
}

export interface ChatSummary {
	id: string;
	title: string;
	updatedAt: string;
	messageCount: number;
}

const TITLE_LENGTH = 60;

/** How long saved chats are kept, in days; 0 keeps them indefinitely. */
export const CHAT_RETENTION_CHOICES: ReadonlyArray<{ days: number; label: string }> = [
	{ days: 1, label: '1 day' },
	{ days: 7, label: '7 days' },
	{ days: 30, label: '30 days' },
	{ days: 365, label: '1 year' },
	{ days: 0, label: 'Indefinitely' },
];

/** Chats last updated before this time are past the retention period; null when kept indefinitely. */
export function retentionCutoff(days: number, now = new Date()): Date | null {
	if (!Number.isFinite(days) || days <= 0) return null;
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** A short title from the first thing the user asked. */
export function chatTitle(messages: readonly SavedChatMessage[]): string {
	const first = messages.find((m) => m.role === 'user' && m.content.trim().length > 0);
	if (!first) return 'New Chat';
	const line = first.content.replace(/\s+/g, ' ').trim();
	return line.length > TITLE_LENGTH ? line.slice(0, TITLE_LENGTH - 1) + '…' : line;
}

/** A file-safe id that sorts by creation time. */
export function newChatId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
	return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSavedChat(value: unknown): value is SavedChat {
	const c = value as SavedChat;
	return !!c && c.version === 1 && typeof c.id === 'string' && typeof c.title === 'string' && Array.isArray(c.messages) && Array.isArray(c.agentMessages);
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export class ChatHistory {
	constructor(private readonly store: HistoryFileStore, private readonly dir: string) {}

	private pathFor(id: string): string {
		// Ids come from newChatId; refuse anything else so a bad id can't point outside the folder.
		if (!SAFE_ID.test(id)) throw new Error(`Invalid chat id: ${id}`);
		return `${this.dir}/${id}.json`;
	}

	async save(chat: SavedChat): Promise<void> {
		if (!(await this.store.exists(this.dir))) await this.store.mkdir(this.dir);
		await this.store.write(this.pathFor(chat.id), JSON.stringify(chat));
	}

	async load(id: string): Promise<SavedChat | null> {
		const path = this.pathFor(id);
		try {
			if (!(await this.store.exists(path))) return null;
			const parsed: unknown = JSON.parse(await this.store.read(path));
			return isSavedChat(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	/** Saved chats, most recently updated first. Unreadable files are skipped. */
	async list(): Promise<ChatSummary[]> {
		if (!(await this.store.exists(this.dir))) return [];
		const { files } = await this.store.list(this.dir);
		const out: ChatSummary[] = [];
		for (const file of files) {
			if (!file.endsWith('.json')) continue;
			const id = (file.split('/').pop() ?? '').replace(/\.json$/, '');
			if (!SAFE_ID.test(id)) continue;
			const chat = await this.load(id);
			if (chat) out.push({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, messageCount: chat.messages.length });
		}
		return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async delete(id: string): Promise<void> {
		const path = this.pathFor(id);
		if (await this.store.exists(path)) await this.store.remove(path);
	}

	/** Deletes every saved chat. Returns how many were removed. */
	async clear(): Promise<number> {
		const chats = await this.list();
		for (const c of chats) await this.delete(c.id);
		return chats.length;
	}

	/** Deletes chats last updated more than `days` days ago (0 keeps everything). Returns how many were removed. */
	async removeOlderThan(days: number, now = new Date()): Promise<number> {
		const cutoff = retentionCutoff(days, now);
		if (!cutoff) return 0;
		const old = (await this.list()).filter((c) => {
			const updated = Date.parse(c.updatedAt);
			return Number.isFinite(updated) && updated < cutoff.getTime();
		});
		for (const c of old) await this.delete(c.id);
		return old.length;
	}

	/** Keeps the newest `max` chats and deletes the rest. */
	async prune(max: number): Promise<void> {
		const chats = await this.list();
		for (const c of chats.slice(Math.max(0, max))) await this.delete(c.id);
	}
}
