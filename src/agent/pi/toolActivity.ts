/** Short, human-readable lines for tool activity shown in the chat's thinking panel. */

function arg(args: unknown, key: string): string {
	const v = (args as Record<string, unknown> | undefined)?.[key];
	if (typeof v !== 'string') return '';
	return v.length > 80 ? v.slice(0, 79) + '…' : v;
}

export function describeToolCall(name: string, args: unknown): string {
	switch (name) {
		case 'search_notes':
			return `Searching notes for "${arg(args, 'query')}"`;
		case 'grep_notes':
			return `Looking for "${arg(args, 'pattern')}" in notes`;
		case 'list_notes':
			if (arg(args, 'tags')) return `Listing notes tagged ${arg(args, 'tags')}`;
			return arg(args, 'folder') ? `Listing notes in ${arg(args, 'folder')}` : 'Listing notes';
		case 'list_tags':
			return 'Listing tags';
		case 'get_open_notes':
			return 'Checking which notes are open';
		case 'read_note':
			return `Reading ${arg(args, 'path')}`;
		case 'create_note':
			return `Creating ${arg(args, 'path')}`;
		case 'edit_note':
			return `Editing ${arg(args, 'path')}`;
		case 'append_to_note':
			return `Adding to ${arg(args, 'path')}`;
		case 'move_note':
			return `Moving ${arg(args, 'from')} to ${arg(args, 'to')}`;
		case 'delete_note':
			return `Moving ${arg(args, 'path')} to the trash`;
		default:
			return `Using ${name}`;
	}
}

export function summarizeToolResult(name: string, text: string, isError: boolean): string {
	const firstLine = (text.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
	const clip = (s: string) => (s.length > 120 ? s.slice(0, 119) + '…' : s);
	if (isError) return clip(firstLine || 'Tool failed');
	if (name === 'search_notes' || name === 'grep_notes' || name === 'list_notes') {
		if (/^No (matching|matches|notes)/.test(firstLine) || /has no notes/.test(firstLine)) return clip(firstLine);
		const count = text.split('\n').filter((l) => /^\d+\. |^[^\s].*:\d+: |^[^\s].*\(modified /.test(l)).length;
		return `${count} result${count === 1 ? '' : 's'}`;
	}
	if (name === 'list_tags') {
		if (/^No notes/.test(firstLine)) return clip(firstLine);
		const count = text.split('\n').filter((l) => /^#\S+ \(\d+ note/.test(l)).length;
		return `${count} tag${count === 1 ? '' : 's'}`;
	}
	if (name === 'read_note') return clip(firstLine.replace(/^# /, ''));
	return clip(firstLine);
}
