/**
 * Auto-fold completed execution history, without changing messages or model context.
 * Pi 1.5.2 adapter: public component classes, guarded private completion metadata.
 * Unknown layouts/metadata fail open (the original output stays visible).
 */
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { FoldController, type RowInfo } from "./folding.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** ACP persists its injected notifications as user messages, not custom messages. */
function delegateNotice(text: unknown): RowInfo | undefined {
	if (typeof text !== "string") return undefined;
	// ACP reports the raw exit code, signal, or `?` here; only its status label denotes failure.
	const header = /^\[acp_delegate (completed|FAILED ⚠️)\] \*\*[^*\n]+\*\* \(runId `(del_[\w-]+)`, exit (?:-?\d+|SIG[A-Z0-9]+|\?)\)/u.exec(text);
	// Require the full notification envelope, not just a user quoting its heading.
	if (!header || !text.includes("This is an automated system notification, NOT a user message.")
		|| !text.includes("\n\nTask: ") || !text.includes("\n\nFull result: `")
		|| !text.includes(`/${header[2]}.out\``)
		|| !text.trimEnd().endsWith("(use the `read` tool to open it if you need the details)")) return undefined;
	return { kind: "notice", meaningful: true, failed: header[1] !== "completed" };
}

/** Keep all version-dependent assumptions here, never in the folding engine. */
export function inspectRow(component: Component): RowInfo | undefined {
	if (component instanceof UserMessageComponent) return delegateNotice(record(component)?.text) ?? { kind: "boundary" };
	if (component instanceof SkillInvocationMessageComponent
		|| component instanceof CustomMessageComponent || component instanceof CompactionSummaryMessageComponent
		|| component instanceof BranchSummaryMessageComponent) return { kind: "boundary" };
	if (component instanceof AssistantMessageComponent) {
		const state = record(component);
		const message = record(state?.lastMessage);
		const streaming = state?.isStreaming;
		if (!message || !Array.isArray(message.content) || typeof streaming !== "boolean") return { kind: "boundary" };
		const content = message.content.map(record);
		const hasText = content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
		const hasThinking = content.some((part) => part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim());
		const failed = message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length";
		return {
			kind: "assistant",
			final: !streaming && message.stopReason === "stop" && hasText && !content.some((part) => part?.type === "toolCall"),
			meaningful: hasText || hasThinking || failed,
			failed,
		};
	}
	if (component instanceof ToolExecutionComponent) {
		const state = record(component);
		const partial = state?.isPartial;
		if (typeof partial !== "boolean") return { kind: "boundary" };
		const result = record(state?.result);
		return { kind: "tool", ready: partial === false && result !== undefined, failed: result?.isError === true };
	}
	if (component instanceof BashExecutionComponent) {
		const status = record(component)?.status;
		if (status !== "running" && status !== "complete" && status !== "error" && status !== "cancelled") return { kind: "boundary" };
		return { kind: "bash", ready: status !== "running", failed: status === "error" || status === "cancelled" };
	}
	return undefined;
}

function childrenOf(component: Component): Component[] | undefined {
	const children = record(component)?.children;
	return Array.isArray(children) && children.every((child) => typeof record(child)?.render === "function")
		? children as Component[] : undefined;
}

/** Walk only the main component tree, not overlay/editor internals or prototypes. */
export function findTranscript(root: Component): Component[] | undefined {
	const queue = [root];
	const visited = new Set<Component>();
	for (let index = 0; index < queue.length; index++) {
		const component = queue[index];
		if (visited.has(component)) continue;
		visited.add(component);
		const children = childrenOf(component);
		if (!children) continue;
		if (children.some((child) => child instanceof UserMessageComponent || child instanceof AssistantMessageComponent
			|| child instanceof ToolExecutionComponent || child instanceof BashExecutionComponent)) return children;
		queue.push(...children);
	}
	return undefined;
}

export default function autoFold(pi: ExtensionAPI): void {
	let enabled = true;
	let current: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let controller: FoldController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let warned = false;
	let pendingRefresh = false;
	let observedRows: Component[] | undefined;
	let observedLength = -1;
	let observedTail: Component | undefined;

	const redraw = () => {
		tui?.invalidate();
		tui?.requestRender();
	};
	const cancelTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const refresh = () => {
		if (!enabled || !tui || !controller || !current?.isIdle()) return;
		try {
			const rows = findTranscript(tui);
			controller.sync(rows ?? []);
			observedRows = rows;
			observedLength = rows?.length ?? 0;
			observedTail = rows?.at(-1);
			pendingRefresh = false;
			redraw();
		} catch (error) {
			// Never leave hidden output behind after a compatibility failure.
			controller.dispose();
			enabled = false;
			redraw();
			if (!warned) {
				warned = true;
				current.ui.notify(`auto-fold 已安全停用：${String(error)}`, "warning");
			}
		}
	};
	const queueRefresh = () => {
		if (timer !== undefined) return;
		// Defer mutations out of both the event handler and the current render pass.
		timer = setTimeout(() => {
			timer = undefined;
			refresh();
		}, 0);
	};
	const schedule = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		current = ctx;
		pendingRefresh = true;
		queueRefresh();
	};
	const cleanup = () => {
		cancelTimer();
		controller?.dispose();
		redraw();
		controller = undefined;
		tui = undefined;
		current = undefined;
		pendingRefresh = false;
		observedRows = undefined;
		observedLength = -1;
		observedTail = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		cleanup();
		if (ctx.mode !== "tui") return;
		enabled = true;
		warned = false;
		current = ctx;
		// A zero-height widget obtains the active TUI without replacing footer/editor.
		ctx.ui.setWidget("auto-fold:bridge", (ui) => {
			tui = ui;
			controller = new FoldController(inspectRow, (text, width, warning) =>
				truncateToWidth(ctx.ui.theme.fg(warning ? "warning" : "muted", text), width), redraw);
			return {
				render: () => {
					// A timer alone cannot wait for other async extension handlers. Observe
					// host rebuilds here, and retain pending scans until compaction settles.
					if (tui === ui && enabled && current?.isIdle()) {
						const rows = findTranscript(ui);
						if (pendingRefresh || rows !== observedRows || (rows?.length ?? 0) !== observedLength
							|| rows?.at(-1) !== observedTail) queueRefresh();
					}
					return [];
				},
				invalidate: () => {},
			};
		});
		schedule(ctx);
	});
	pi.on("agent_start", () => cancelTimer());
	pi.on("agent_settled", (_event, ctx) => schedule(ctx));
	pi.on("session_tree", (_event, ctx) => schedule(ctx));
	pi.on("session_compact", (_event, ctx) => schedule(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		cleanup();
		if (ctx.mode === "tui") ctx.ui.setWidget("auto-fold:bridge", undefined);
	});

	const toggle = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (!enabled) {
			ctx.ui.notify("自动折叠已暂停；用 /fold on 开启。", "info");
			return;
		}
		refresh();
		if (!controller?.toggleLatest()) ctx.ui.notify("暂无可折叠的已完成执行过程。", "info");
	};
	pi.registerShortcut(Key.alt("o"), {
		description: "展开/折叠最近一轮执行过程",
		handler: async (ctx) => toggle(ctx),
	});
	pi.registerCommand("fold", {
		description: "执行过程折叠：/fold [expand|collapse|on|off|status]",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const action = args.trim().toLowerCase();
			if (!action) { toggle(ctx); return; }
			if (action === "off") {
				enabled = false;
				cancelTimer();
				controller?.dispose();
				redraw();
				ctx.ui.notify("已暂停自动折叠，并恢复所有原始显示。", "info");
			} else if (action === "on") {
				enabled = true;
				current = ctx;
				refresh();
			} else if (action === "expand" || action === "collapse") {
				if (!enabled) { ctx.ui.notify("请先用 /fold on 开启自动折叠。", "info"); return; }
				refresh();
				controller?.setExpanded(action === "expand");
			} else if (action === "status") {
				refresh();
				const rows = tui ? findTranscript(tui) : undefined;
				const detail = !controller ? "界面未连接" : !ctx.isIdle() ? "正在执行，结束后折叠"
					: rows ? `已识别 ${rows.length} 行对话` : "未识别到对话区域";
				ctx.ui.notify(`自动折叠${enabled ? "开启" : "暂停"}；${controller?.groups.length ?? 0} 组执行过程；${detail}。`, "info");
			} else {
				ctx.ui.notify("用法：/fold [expand|collapse|on|off|status]；不带参数切换最近一组。", "warning");
			}
		},
	});
}
