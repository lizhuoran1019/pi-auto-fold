import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";

/** The host adapter is deliberately separate from the display-only folding logic. */
export interface RowInfo {
	kind: "boundary" | "assistant" | "tool" | "bash" | "notice";
	/** Only a complete, successful assistant answer can close a group. */
	final?: boolean;
	ready?: boolean;
	meaningful?: boolean;
	failed?: boolean;
}

export interface FoldGroup {
	answer: Component;
	members: Component[];
	tools: number;
	messages: number;
	failures: number;
	expanded: boolean;
}

export type InspectRow = (component: Component) => RowInfo | undefined;

/** Unknown rows stay visible; real user/custom/summary boundaries are never crossed. */
export function planGroups(rows: readonly Component[], inspect: InspectRow): FoldGroup[] {
	const groups: FoldGroup[] = [];
	let segment: { component: Component; info: RowInfo }[] = [];
	const flush = () => {
		const lastAssistant = segment.findLastIndex((row) => row.info.kind === "assistant");
		const answer = segment[lastAssistant];
		if (answer?.info.final) {
			const before = segment.slice(0, lastAssistant);
			// Missing/unfinished tool results are not evidence of a completed execution.
			const unfinished = segment.some((row) => row.info.kind === "tool" && row.info.ready !== true);
			const laterTool = segment.slice(lastAssistant + 1).some((row) => row.info.kind === "tool");
			const members = before.filter((row) => row.info.kind !== "bash" || row.info.ready === true);
			const tools = members.filter((row) => row.info.kind === "tool" || row.info.kind === "bash").length;
			const messages = members.filter((row) => (row.info.kind === "assistant" || row.info.kind === "notice") && row.info.meaningful).length;
			if (!unfinished && !laterTool && (tools > 0 || messages > 0)) {
				groups.push({
					answer: answer.component,
					members: members.map((row) => row.component),
					tools,
					messages,
					failures: members.filter((row) => row.info.failed).length,
					expanded: false,
				});
			}
		}
		segment = [];
	};
	for (const component of rows) {
		const info = inspect(component);
		if (info?.kind === "boundary") flush();
		else if (info) segment.push({ component, info });
	}
	flush();
	return groups;
}

export function summaryText(group: FoldGroup): string {
	const counts = [
		group.tools ? `${group.tools} 项工具/命令` : "",
		group.messages ? `${group.messages} 条过程消息` : "",
		group.failures ? `⚠ ${group.failures} 条失败记录` : "",
	].filter(Boolean).join(" · ");
	return `${group.expanded ? "▾" : "▸"} 执行过程：${counts}  [点击${group.expanded ? "折叠" : "展开"} · Alt+O · /fold]`;
}

/** Restore only our own assignment, never overwrite a later extension's wrapper. */
function patch<K extends "render" | "handleMouse">(row: Component, key: K, value: Component[K]): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(row, key);
	row[key] = value;
	return () => {
		if (row[key] !== value) return;
		if (descriptor) Object.defineProperty(row, key, descriptor);
		else Reflect.deleteProperty(row, key);
	};
}

export class FoldController {
	groups: FoldGroup[] = [];
	private restores: (() => void)[] = [];

	constructor(
		private readonly inspect: InspectRow,
		private readonly format: (text: string, width: number, warning: boolean) => string,
		private readonly requestRender: () => void,
	) {}

	sync(rows: readonly Component[]): void {
		const expanded = new Map(this.groups.map((group) => [group.answer, group.expanded]));
		this.restore();
		this.groups = planGroups(rows, this.inspect);
		for (const group of this.groups) {
			group.expanded = expanded.get(group.answer) ?? false;
			for (const [index, row] of group.members.entries()) this.wrap(row, group, index === 0);
		}
	}

	toggleLatest(): boolean {
		const group = this.groups.at(-1);
		if (!group) return false;
		group.expanded = !group.expanded;
		this.requestRender();
		return true;
	}

	setExpanded(expanded: boolean): void {
		for (const group of this.groups) group.expanded = expanded;
		this.requestRender();
	}

	dispose(): void {
		this.restore();
		this.groups = [];
	}

	private restore(): void {
		for (const restore of this.restores.toReversed()) restore();
		this.restores = [];
	}

	private wrap(row: Component, group: FoldGroup, anchor: boolean): void {
		const originalRender = row.render;
		const originalMouse = row.handleMouse;
		let active = true;
		const render = (width: number): string[] => {
			if (!active) return originalRender.call(row, width);
			if (width <= 0) return [];
			const heading = anchor ? ["", this.format(summaryText(group), width, group.failures > 0)] : [];
			return group.expanded ? [...heading, ...originalRender.call(row, width)] : heading;
		};
		const handleMouse = (event: TuiMouseEvent) => {
			if (!active) return originalMouse?.call(row, event);
			if (anchor && event.y === 1 && event.type === "click" && event.button === "left"
				&& !event.shift && !event.ctrl && !event.alt) {
				group.expanded = !group.expanded;
				this.requestRender();
				return { handled: true };
			}
			if (!group.expanded) return undefined;
			if (!anchor) return originalMouse?.call(row, event);
			if (event.y < 2) return undefined;
			return originalMouse?.call(row, { ...event, y: event.y - 2, height: Math.max(0, event.height - 2) });
		};
		const undoRender = patch(row, "render", render);
		try {
			const undoMouse = patch(row, "handleMouse", handleMouse);
			this.restores.push(() => {
				// If another extension kept our wrapper, it becomes a transparent pass-through.
				active = false;
				undoMouse();
				undoRender();
			});
		} catch (error) {
			// A future host may make mouse handling read-only. Undo a partial install.
			active = false;
			undoRender();
			throw error;
		}
	}
}
