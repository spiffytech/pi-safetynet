/**
 * Single-page permission prompt for omp, ported from pi-safetynet's
 * PermissionPromptComponent onto omp's ctx.ui.custom().
 *
 * Deliberately NOT askDialog-based: askDialog has no default-checked support,
 * forces a Submit tab for any multi-select question, and renders one tab per
 * question. This component is one page, items default-checked, no submit page.
 */
import type {
	Component,
	Focusable,
	TUI,
	EditorTheme,
} from "@oh-my-pi/pi-tui";
import {
	Editor,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type KeyId,
} from "@oh-my-pi/pi-tui";
import { DynamicBorder, getEditorTheme, type Theme, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { toDisplayPath } from "./core/project.ts";
import type { PromptKeybindings, PermissionDuration } from "./core/types.ts";

export type OmpPermissionPromptResult =
	| {
			kind: "approve";
			approved: Map<string, string>;
			skipped: string[];
			skippedDisplay: string[];
			duration: PermissionDuration;
	  }
	| { kind: "deny"; explanation: string };

export interface OmpPermissionPromptOptions {
	permission: "bash" | "read" | "edit";
	target: string;
	unapproved?: string[];
	/** Display form of each unapproved subcommand (preserves quoting). */
	unapprovedDisplay?: string[];
	redirectTargets?: Array<{ permission: "read" | "edit"; path: string }>;
	reason?: string;
	/** True when re-prompting after rules were added but still insufficient. */
	reprompt?: boolean;
	keybindings: PromptKeybindings;
}

interface CommandListItem {
	original: string;
	display: string;
	text: string;
	checked: boolean;
	editing: boolean;
	input?: Input;
	isFile: boolean;
	filePermission?: "read" | "edit";
}

interface DurationOption {
	value: PermissionDuration;
	label: string;
}

type FocusZone = "commands" | "duration" | "deny";

const MAX_DISPLAY_CHARS = 280;

function displayText(item: CommandListItem): string {
	if (item.isFile) return toDisplayPath(item.text);
	const firstNewline = item.text.indexOf("\n");
	const firstLine = firstNewline >= 0 ? item.text.slice(0, firstNewline) : item.text;
	if (firstLine.length <= MAX_DISPLAY_CHARS) return firstLine;
	return firstLine.slice(0, MAX_DISPLAY_CHARS - 1) + "…";
}

// Regexes for stripping omp's Editor border lines so the deny editor inlines
// cleanly into the widget (ported from pi-ask / pi-safetynet).
const EDITOR_BORDER_PATTERN = /^[┌┐└┘─]+$/;
const EDITOR_SCROLL_BORDER_PATTERN = /^─── [↑↓] \d+ more ─*$/;

function isEditorBorderLine(line: string): boolean {
	const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
	return EDITOR_BORDER_PATTERN.test(stripped) || EDITOR_SCROLL_BORDER_PATTERN.test(stripped);
}

function getEditorContentLines(editorLines: readonly string[]): string[] {
	if (editorLines.length <= 2) return [...editorLines];
	const contentLines = editorLines.slice(1);
	const trailingBorderIndex = contentLines.findIndex(isEditorBorderLine);
	if (trailingBorderIndex === -1) return contentLines;
	return contentLines.filter((_, i) => i !== trailingBorderIndex);
}

function keybindLabel(keyId: string): string {
	if (keyId === "escape" || keyId === "esc") return "esc";
	const shiftLetter = /^shift\+([a-z])$/.exec(keyId);
	if (shiftLetter) return shiftLetter[1]!.toUpperCase();
	return keyId;
}

function makeItem(text: string, isFile: boolean, display?: string, filePermission?: "read" | "edit"): CommandListItem {
	return {
		original: text,
		display: display ?? text,
		text: display ?? text,
		checked: true, // default-checked
		editing: false,
		isFile,
		...(filePermission ? { filePermission } : {}),
	};
}

function getDurationOptions(): DurationOption[] {
	return [
		{ value: "once", label: "Once" },
		{ value: "session", label: "Session" },
		{ value: "project", label: "Project" },
		{ value: "turn", label: "Turn" },
		{ value: "global", label: "Global" },
	];
}

class PermissionPromptComponent implements Component, Focusable {
	focused = false;

	private items: CommandListItem[];
	private durationOptions: DurationOption[];
	private headerText: string;
	private extraHeaderLines: string[];
	private reason: string | undefined;
	private selectedIndex = 0;
	private selectedDuration = 1; // default: Session
	private focusZone: FocusZone = "duration";
	private theme: Theme;
	private cachedWidth: number | undefined;
	private cachedLines: readonly string[] | undefined;
	private denyEditor: Editor;
	private keybindings: PromptKeybindings;
	onConfirm?: (result: OmpPermissionPromptResult) => void;
	onCancel?: () => void;

	constructor(
		items: CommandListItem[],
		durationOptions: DurationOption[],
		headerText: string,
		extraHeaderLines: string[],
		reason: string | undefined,
		theme: Theme,
		denyEditor: Editor,
		keybindings: PromptKeybindings,
	) {
		this.items = items;
		this.durationOptions = durationOptions;
		this.headerText = headerText;
		this.extraHeaderLines = extraHeaderLines;
		this.reason = reason;
		this.theme = theme;
		this.denyEditor = denyEditor;
		this.keybindings = keybindings;
	}

	render(width: number): readonly string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const innerW = width - 2;

		lines.push(this.theme.fg("warning", truncateToWidth(this.headerText, innerW)));
		for (const h of this.extraHeaderLines) {
			lines.push(this.theme.fg("muted", " " + truncateToWidth(h, innerW - 1)));
		}
		lines.push("");

		const groupLabel = (it: CommandListItem): string | null => {
			if (!it.isFile) return "Commands";
			return it.filePermission === "read" ? "Files read" : "Files written";
		};
		const distinctGroups =
			new Set(this.items.map(groupLabel).filter((g): g is string => g !== null)).size;
		let prevGroup: string | null = null;
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const group = groupLabel(item);
			if (distinctGroups > 1 && group !== null && group !== prevGroup) {
				if (prevGroup !== null) lines.push("");
				lines.push(this.theme.fg("muted", " " + group + ":"));
				prevGroup = group;
			}

			const isActive = this.focusZone === "commands" && i === this.selectedIndex;

			if (item.editing && item.input) {
				const inputLines = item.input.render(innerW - 4);
				for (let j = 0; j < inputLines.length; j++) {
					const il = inputLines[j]!;
					lines.push("   " + il);
				}
			} else {
				const checkbox = item.checked ? "[X]" : "[ ]";
				const cursor = isActive ? "▸" : " ";
				const dt = displayText(item);
				const line = `${cursor}${checkbox} ${truncateToWidth(dt, innerW - 6)}`;
				lines.push(isActive ? this.theme.fg("accent", line) : line);
			}
		}

		lines.push("");

		if (this.reason) {
			lines.push(this.theme.fg("muted", " " + truncateToWidth(`Reason: ${this.reason}`, innerW - 1)));
			lines.push("");
		}

		{
			const parts: string[] = [];
			for (let i = 0; i < this.durationOptions.length; i++) {
				const opt = this.durationOptions[i]!;
				const isActive = this.focusZone === "duration" && i === this.selectedDuration;
				const badge = this.theme.fg("dim", `${i + 1}:`);
				const label = `${badge}${opt.label}`;
				if (isActive) {
					parts.push(this.theme.fg("accent", this.theme.bold(`[${label}]`)));
				} else {
					parts.push(` ${label} `);
				}
			}
			lines.push(" " + parts.join("  "));
		}

		{
			lines.push("");
			if (this.focusZone === "deny") {
				const text = this.denyEditor.getText();
				const isEmpty = text.length === 0;
				lines.push(this.theme.fg("accent", " ▸ deny:"));
				const editorLines = this.denyEditor.render(innerW - 4);
				const content = getEditorContentLines(editorLines);
				if (isEmpty) {
					lines.push(this.theme.fg("muted", "   type a reason, or Enter to deny"));
				} else {
					for (const el of content) lines.push("   " + el);
				}
			} else {
				lines.push(" [Deny…]");
			}
		}

		{
			const denyAbortLabel = keybindLabel(this.keybindings.denyAbort);
			const denyContinueLabel = this.keybindings.denyContinue
				? keybindLabel(this.keybindings.denyContinue)
				: null;
			const denyContinueHint = denyContinueLabel ? ` · ${denyContinueLabel} deny` : "";
			const help = this.focusZone === "deny"
				? "enter deny (empty = no reason) · esc back · ↑ duration · ↓ commands"
				: this.focusZone === "commands"
					? `↑↓ navigate · space toggle · enter edit · ${denyAbortLabel} abort${denyContinueHint}`
					: `←→ switch · enter confirm · 1-5 quick-approve · ↓ deny · ↑ commands · ${denyAbortLabel} abort${denyContinueHint}`;
			lines.push(this.theme.fg("dim", " " + truncateToWidth(help, innerW - 1)));
		}

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		for (const item of this.items) {
			if (item.input) item.input.invalidate();
		}
		this.denyEditor.invalidate();
	}

	handleInput(data: string): void {
		if (this.focusZone === "commands" && this.selectedIndex < this.items.length) {
			const item = this.items[this.selectedIndex]!;
			if (item.editing && item.input) {
				this.handleEditInput(data, item);
				return;
			}
		}

		if (this.focusZone === "deny") {
			this.handleDenyEditorInput(data);
			return;
		}

		if (this.keybindings.denyContinue && matchesKey(data, this.keybindings.denyContinue as KeyId)) {
			this.onConfirm?.({ kind: "deny", explanation: "" });
			return;
		}
		if (matchesKey(data, this.keybindings.denyAbort as KeyId)) {
			this.onCancel?.();
			return;
		}

		if (this.focusZone === "commands") {
			this.handleCommandsInput(data);
		} else if (this.focusZone === "duration") {
			this.handleDurationInput(data);
		}
	}

	private handleCommandsInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.invalidate();
			}
		} else if (matchesKey(data, Key.down)) {
			if (this.selectedIndex < this.items.length - 1) {
				this.selectedIndex++;
				this.invalidate();
			} else {
				this.focusZone = "duration";
				this.invalidate();
			}
		} else if (matchesKey(data, Key.space)) {
			const item = this.items[this.selectedIndex]!;
			item.checked = !item.checked;
			this.invalidate();
		} else if (matchesKey(data, Key.enter)) {
			this.startEdit(this.selectedIndex);
		}
	}

	private handleDurationInput(data: string): void {
		const digitIndex = this.durationOptions.findIndex((_, i) => matchesKey(data, String(i + 1) as KeyId));
		if (digitIndex >= 0) {
			this.selectedDuration = digitIndex;
			this.invalidate();
			this.confirm();
			return;
		}
		if (matchesKey(data, Key.left)) {
			if (this.selectedDuration > 0) {
				this.selectedDuration--;
				this.invalidate();
			}
		} else if (matchesKey(data, Key.right)) {
			if (this.selectedDuration < this.durationOptions.length - 1) {
				this.selectedDuration++;
				this.invalidate();
			}
		} else if (matchesKey(data, Key.enter)) {
			this.confirm();
		} else if (matchesKey(data, Key.down)) {
			this.focusZone = "deny";
			this.denyEditor.setText("");
			this.invalidate();
		} else if (matchesKey(data, Key.up)) {
			this.focusZone = "commands";
			this.selectedIndex = this.items.length - 1;
			this.invalidate();
		}
	}

	private handleDenyEditorInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.focusZone = "duration";
			this.invalidate();
			return;
		}
		const isEmpty = this.denyEditor.getText().length === 0;
		if (matchesKey(data, Key.enter)) {
			const explanation = this.denyEditor.getText().trim();
			this.onConfirm?.({ kind: "deny", explanation });
			return;
		}
		if (isEmpty) {
			if (matchesKey(data, Key.up)) {
				this.focusZone = "duration";
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.focusZone = "commands";
				this.selectedIndex = 0;
				this.invalidate();
				return;
			}
		}
		this.denyEditor.handleInput(data);
		this.invalidate();
	}

	private startEdit(index: number): void {
		const item = this.items[index]!;
		if (item.editing) return;
		item.editing = true;

		const editValue = item.isFile ? toDisplayPath(item.text) : item.text;

		if (!item.input) {
			const input = new Input();
			input.setValue(editValue);
			item.input = input;
		} else {
			item.input.setValue(editValue);
		}
		this.invalidate();
	}

	private finishEdit(index: number, confirm: boolean): void {
		const item = this.items[index]!;
		if (!item.editing) return;

		if (confirm && item.input) {
			const newValue = item.input.getValue().trim();
			if (newValue.length > 0) {
				item.text = newValue;
			}
		}

		item.editing = false;
		this.invalidate();
	}

	private handleEditInput(data: string, item: CommandListItem): void {
		if (matchesKey(data, Key.enter)) {
			this.finishEdit(this.selectedIndex, true);
		} else if (matchesKey(data, Key.escape)) {
			item.text = item.display;
			item.editing = false;
			this.invalidate();
		} else {
			item.input!.handleInput(data);
			this.invalidate();
		}
	}

	private confirm(): void {
		const approved = new Map<string, string>();
		const skipped: string[] = [];
		const skippedDisplay: string[] = [];

		for (const item of this.items) {
			if (item.checked) {
				const pattern = item.text === item.display ? item.original : item.text;
				approved.set(item.original, pattern);
			} else {
				skipped.push(item.original);
				skippedDisplay.push(item.display);
			}
		}

		const duration = this.durationOptions[this.selectedDuration]!.value;
		this.onConfirm?.({ kind: "approve", approved, skipped, skippedDisplay, duration });
	}
}

class BorderedPermissionPrompt implements Component, Focusable {
	focused = false;
	private inner: PermissionPromptComponent;
	private theme: Theme;

	constructor(inner: PermissionPromptComponent, theme: Theme) {
		this.inner = inner;
		this.theme = theme;
	}

	private border = new DynamicBorder((s: string) => this.theme.fg("borderAccent", s));

	render(width: number): readonly string[] {
		const innerLines = this.inner.render(width - 2);
		const lines: string[] = [];

		lines.push(...this.border.render(width));

		for (const line of innerLines) {
			const padNeeded = Math.max(0, width - 2 - visibleWidth(line));
			const padded = line + " ".repeat(padNeeded);
			lines.push(this.theme.fg("borderAccent", "│") + padded + this.theme.fg("borderAccent", "│"));
		}

		lines.push(...this.border.render(width));
		return lines;
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	handleInput(data: string): void {
		this.inner.handleInput(data);
	}
}

export async function showOmpPermissionPrompt(
	ctx: ExtensionContext,
	opts: OmpPermissionPromptOptions,
): Promise<OmpPermissionPromptResult | null> {
	if (!ctx.hasUI) return null;

	const isFile = opts.permission === "read" || opts.permission === "edit";

	const items: CommandListItem[] = [];

	if (isFile) {
		items.push(makeItem(opts.target, true, undefined, opts.permission as "read" | "edit"));
	} else {
		const unapproved = opts.unapproved?.length ? opts.unapproved : [opts.target];
		const unapprovedDisplay = opts.unapprovedDisplay?.length ? opts.unapprovedDisplay : [];
		for (let i = 0; i < unapproved.length; i++) {
			const sub = unapproved[i]!;
			const display = unapprovedDisplay[i];
			items.push(makeItem(sub, false, display));
		}
	}

	if (opts.redirectTargets?.length) {
		for (const rt of opts.redirectTargets) {
			items.push(makeItem(rt.path, true, undefined, rt.permission));
		}
	}

	const extraHeader: string[] = [];
	if (opts.reprompt) {
		extraHeader.push("ℹ️ Rules were added but still insufficient — additional approval needed.");
	}

	const headerText = isFile
		? `⚠️ ${opts.permission} approval required`
		: "⚠️ bash approval required";

	const durationOptions = getDurationOptions();

	return ctx.ui.custom<OmpPermissionPromptResult | null>((tui, theme, _keybindings, done) => {
		const denyEditor = new Editor(getEditorTheme());
		// We bind submission ourselves (Enter on the deny row submits the whole
		// buffer); the editor's native Enter behaviour is disabled.
		denyEditor.disableSubmit = true;

		const inner = new PermissionPromptComponent(
			items,
			durationOptions,
			headerText,
			extraHeader,
			opts.reason,
			theme,
			denyEditor,
			opts.keybindings,
		);
		inner.onConfirm = (result) => done(result);
		inner.onCancel = () => done(null);

		const wrapper = new BorderedPermissionPrompt(inner, theme);

		// Propagate Focusable.
		Object.defineProperty(wrapper, "focused", {
			get: () => inner.focused,
			set: (v: boolean) => {
				inner.focused = v;
			},
			configurable: true,
			enumerable: true,
		});

		// Patch handleInput to also request a render (omp's custom() sets focus
		// once at mount; subsequent keypresses need an explicit repaint).
		const origHandleInput = wrapper.handleInput.bind(wrapper);
		wrapper.handleInput = (data: string) => {
			origHandleInput(data);
			tui.requestRender();
		};

		return wrapper;
	});
}
