import { Type } from 'typebox';
import { VaultPort, VaultFileInfo, isMarkdown, normalizeVaultPath, withMarkdownExtension } from '../vault/VaultPort';
import { VaultSearch } from '../search/VaultSearch';

/**
 * One vault tool, described once. The built-in MCP server publishes these
 * definitions; the Pi agent reaches them through that server.
 */
export interface VaultToolDefinition {
	name: string;
	title: string;
	description: string;
	inputSchema: { type: 'object'; [key: string]: unknown };
	/** True for tools that never change the vault. */
	readOnly: boolean;
	/** True for tools whose effect is hard to undo (moving or trashing notes). */
	destructive?: boolean;
	run(args: Record<string, unknown>): Promise<string>;
}

export interface VaultToolContext {
	vault: VaultPort;
	search: VaultSearch;
}

const DEFAULT_READ_LINES = 400;
const MAX_READ_CHARS = 24000;

function str(args: Record<string, unknown>, key: string, required = true): string {
	const v = args[key];
	if (typeof v === 'string' && v.length > 0) return v;
	if (!required && (v === undefined || v === null || v === '')) return '';
	throw new Error(`"${key}" must be a non-empty string`);
}

function num(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
	const v = args[key];
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function bool(args: Record<string, unknown>, key: string): boolean {
	const v = args[key];
	return v === true || v === 'true';
}

function schema(properties: Record<string, unknown>): VaultToolDefinition['inputSchema'] {
	// JSON round-trip drops TypeBox's symbol metadata so the schema is plain JSON Schema.
	// TypeBox marks every non-Optional property as required.
	return JSON.parse(JSON.stringify(Type.Object(properties as Parameters<typeof Type.Object>[0])));
}

function describeFile(f: VaultFileInfo): string {
	return `${f.path}  (modified ${new Date(f.mtime).toISOString().slice(0, 10)}, ${f.size} bytes)`;
}

export function createVaultTools(ctx: VaultToolContext): VaultToolDefinition[] {
	const { vault, search } = ctx;

	/** Finds a visible note from a model-supplied path, tolerating a missing ".md" or a bare note name. */
	const resolveNote = (input: string): VaultFileInfo => {
		const path = normalizeVaultPath(input);
		const candidates = [path, withMarkdownExtension(path)];
		for (const c of candidates) {
			const f = vault.getFile(c);
			if (f && search.isVisible(f.path)) return f;
		}
		const wanted = (path.split('/').pop() ?? path).replace(/\.md$/i, '').toLowerCase();
		const byName = search.notes().filter((f) => f.basename.toLowerCase() === wanted);
		if (byName.length === 1) return byName[0];
		if (byName.length > 1) {
			throw new Error(`"${input}" matches several notes; use the full path: ${byName.map((f) => f.path).join(', ')}`);
		}
		throw new Error(`Note not found: ${input}. Use search_notes or list_notes to find the right path.`);
	};

	const assertWritablePath = (input: string): string => {
		const path = withMarkdownExtension(normalizeVaultPath(input));
		if (!search.isVisible(path)) throw new Error(`Path is excluded by the plugin settings: ${path}`);
		return path;
	};

	const tools: VaultToolDefinition[] = [
		{
			name: 'search_notes',
			title: 'Search notes',
			description:
				'Ranked keyword search (BM25) over every note, and over text extracted from images. ' +
				'Returns paths with a snippet. Search before reading. If results look wrong, try synonyms or related words and search again.',
			inputSchema: schema(
				{
					query: Type.String({ description: 'Keywords to look for' }),
					limit: Type.Optional(Type.Integer({ description: 'Max results (default 8, max 25)' })),
					folder: Type.Optional(Type.String({ description: 'Only search inside this folder' })),
				},
			),
			readOnly: true,
			async run(args) {
				const hits = await search.search(str(args, 'query'), num(args, 'limit', 8, 1, 25), str(args, 'folder', false) || undefined);
				if (hits.length === 0) return 'No matching notes. Try different or fewer keywords, or grep_notes for an exact phrase.';
				return hits
					.map((h, i) => `${i + 1}. ${h.path}${h.kind === 'image' ? ' [image text]' : ''} (score ${h.score})\n   ${h.snippet}`)
					.join('\n');
			},
		},
		{
			name: 'grep_notes',
			title: 'Grep notes',
			description:
				'Find exact text (or a regular expression) in notes, newest notes first. Returns path:line: text. ' +
				'Best for names, dates, numbers, tags and exact phrases.',
			inputSchema: schema(
				{
					pattern: Type.String({ description: 'Text or regular expression to find' }),
					regex: Type.Optional(Type.Boolean({ description: 'Treat pattern as a regular expression (default false)' })),
					case_sensitive: Type.Optional(Type.Boolean({ description: 'Default false' })),
					folder: Type.Optional(Type.String({ description: 'Only search inside this folder' })),
					limit: Type.Optional(Type.Integer({ description: 'Max matching lines (default 50)' })),
				},
			),
			readOnly: true,
			async run(args) {
				const matches = await search.grep(str(args, 'pattern'), {
					regex: bool(args, 'regex'),
					caseSensitive: bool(args, 'case_sensitive'),
					pathPrefix: str(args, 'folder', false) || undefined,
					limit: num(args, 'limit', 50, 1, 200),
				});
				if (matches.length === 0) return 'No matches.';
				return matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
			},
		},
		{
			name: 'list_notes',
			title: 'List notes',
			description: 'List notes, most recently modified first, optionally inside one folder.',
			inputSchema: schema({
				folder: Type.Optional(Type.String({ description: 'Folder to list (default: whole vault)' })),
				limit: Type.Optional(Type.Integer({ description: 'Max notes (default 50, max 500)' })),
			}),
			readOnly: true,
			async run(args) {
				const folder = str(args, 'folder', false).replace(/^\/+|\/+$/g, '');
				const prefix = folder ? folder + '/' : '';
				const limit = num(args, 'limit', 50, 1, 500);
				const notes = search
					.notes()
					.filter((f) => !prefix || f.path.startsWith(prefix))
					.sort((a, b) => b.mtime - a.mtime);
				if (notes.length === 0) return folder ? `No notes in ${folder}.` : 'The vault has no notes.';
				const shown = notes.slice(0, limit).map(describeFile).join('\n');
				return notes.length > limit ? `${shown}\n… ${notes.length - limit} more` : shown;
			},
		},
		{
			name: 'get_open_notes',
			title: 'Get open notes',
			description: 'Paths of the note the user is looking at right now and the other notes open in tabs.',
			inputSchema: schema({}),
			readOnly: true,
			async run() {
				const active = vault.getActiveNotePath?.() ?? null;
				const open = (vault.getOpenNotePaths?.() ?? []).filter((p) => search.isVisible(p));
				const lines = [`Active note: ${active && search.isVisible(active) ? active : '(none)'}`];
				lines.push(open.length ? `Open notes:\n${open.map((p) => `- ${p}`).join('\n')}` : 'Open notes: (none)');
				return lines.join('\n');
			},
		},
		{
			name: 'read_note',
			title: 'Read note',
			description: 'Read a note. Long notes come back in pages of lines; use start_line to continue.',
			inputSchema: schema(
				{
					path: Type.String({ description: 'Vault path, e.g. "Home/Water Heater.md"' }),
					start_line: Type.Optional(Type.Integer({ description: 'First line to return, 1-based (default 1)' })),
					max_lines: Type.Optional(Type.Integer({ description: `Lines to return (default ${DEFAULT_READ_LINES})` })),
				},
			),
			readOnly: true,
			async run(args) {
				const file = resolveNote(str(args, 'path'));
				if (!isMarkdown(file)) throw new Error(`${file.path} is not a markdown note`);
				const lines = (await vault.read(file.path)).split('\n');
				const start = num(args, 'start_line', 1, 1, Math.max(1, lines.length));
				const count = num(args, 'max_lines', DEFAULT_READ_LINES, 1, 2000);
				let body = lines.slice(start - 1, start - 1 + count).join('\n');
				let end = Math.min(lines.length, start - 1 + count);
				if (body.length > MAX_READ_CHARS) {
					body = body.slice(0, MAX_READ_CHARS);
					end = start - 1 + body.split('\n').length;
				}
				const header = `# ${file.path} (lines ${start}-${end} of ${lines.length}, modified ${new Date(file.mtime).toISOString().slice(0, 10)})`;
				const more = end < lines.length ? `\n… more below; call read_note with start_line ${end + 1}` : '';
				return `${header}\n${body}${more}`;
			},
		},
		{
			name: 'create_note',
			title: 'Create note',
			description: 'Create a new note. Fails if the note already exists. Folders are created as needed.',
			inputSchema: schema(
				{
					path: Type.String({ description: 'Vault path for the new note; ".md" is added if missing' }),
					content: Type.String({ description: 'Markdown content' }),
				},
			),
			readOnly: false,
			async run(args) {
				const path = assertWritablePath(str(args, 'path'));
				if (vault.getFile(path)) throw new Error(`A note already exists at ${path}. Use edit_note or append_to_note.`);
				const content = typeof args.content === 'string' ? args.content : '';
				await vault.create(path, content);
				return `Created ${path} (${content.length} characters).`;
			},
		},
		{
			name: 'edit_note',
			title: 'Edit note',
			description:
				'Replace one exact passage in a note. old_text must appear exactly once; read the note first and copy it verbatim.',
			inputSchema: schema(
				{
					path: Type.String(),
					old_text: Type.String({ description: 'Exact text to replace (must be unique in the note)' }),
					new_text: Type.String({ description: 'Replacement text (empty string deletes old_text)' }),
				},
			),
			readOnly: false,
			async run(args) {
				const file = resolveNote(str(args, 'path'));
				const oldText = str(args, 'old_text');
				const newText = typeof args.new_text === 'string' ? args.new_text : '';
				const content = await vault.read(file.path);
				const first = content.indexOf(oldText);
				if (first < 0) throw new Error(`old_text was not found in ${file.path}. Read the note and copy the passage exactly.`);
				if (content.indexOf(oldText, first + 1) >= 0) {
					throw new Error(`old_text appears more than once in ${file.path}. Include more surrounding text.`);
				}
				await vault.modify(file.path, content.slice(0, first) + newText + content.slice(first + oldText.length));
				return `Edited ${file.path}.`;
			},
		},
		{
			name: 'append_to_note',
			title: 'Append to note',
			description: 'Add text to the end of a note (creates the note if it does not exist).',
			inputSchema: schema(
				{
					path: Type.String(),
					content: Type.String({ description: 'Markdown to append' }),
				},
			),
			readOnly: false,
			async run(args) {
				const content = str(args, 'content');
				let existing: VaultFileInfo | null = null;
				try {
					existing = resolveNote(str(args, 'path'));
				} catch {
					existing = null;
				}
				if (!existing) {
					const path = assertWritablePath(str(args, 'path'));
					await vault.create(path, content);
					return `Created ${path}.`;
				}
				const current = await vault.read(existing.path);
				const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
				await vault.modify(existing.path, current + sep + content);
				return `Appended ${content.length} characters to ${existing.path}.`;
			},
		},
		{
			name: 'move_note',
			title: 'Move or rename note',
			description: 'Move or rename a note. Links to it are updated by Obsidian. Only do this when the user asked for it.',
			inputSchema: schema(
				{
					from: Type.String({ description: 'Current path' }),
					to: Type.String({ description: 'New path' }),
				},
			),
			readOnly: false,
			destructive: true,
			async run(args) {
				const file = resolveNote(str(args, 'from'));
				const to = assertWritablePath(str(args, 'to'));
				if (vault.getFile(to)) throw new Error(`Something already exists at ${to}`);
				await vault.rename(file.path, to);
				return `Moved ${file.path} to ${to}.`;
			},
		},
		{
			name: 'delete_note',
			title: 'Delete note',
			description:
				'Move a note to the trash (recoverable). Only do this when the user explicitly asked to delete that note.',
			inputSchema: schema({ path: Type.String() }),
			readOnly: false,
			destructive: true,
			async run(args) {
				const file = resolveNote(str(args, 'path'));
				await vault.trash(file.path);
				return `Moved ${file.path} to the trash.`;
			},
		},
	];

	return tools;
}
