import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const extensionDir = fileURLToPath(new URL("..", import.meta.url));
const piRoot = process.env.PI_PACKAGE_ROOT ?? path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const piEntry = path.join(piRoot, "dist/index.js");
const requireHost = createRequire(piEntry);
const tuiEntry = requireHost.resolve("@earendil-works/pi-tui");
const host = await import(pathToFileURL(piEntry).href);
const tui = await import(pathToFileURL(tuiEntry).href);
const { createJiti } = await import(pathToFileURL(requireHost.resolve("jiti")).href);
const jiti = createJiti(import.meta.url, {
	fsCache: false,
	alias: { "@earendil-works/pi-coding-agent": piEntry, "@earendil-works/pi-tui": tuiEntry },
});
const { FoldController, planGroups, summaryText } = await jiti.import(path.join(extensionDir, "folding.ts"));
const { inspectRow, findTranscript } = await jiti.import(path.join(extensionDir, "index.ts"));
const { loadExtensions } = await import(pathToFileURL(path.join(piRoot, "dist/core/extensions/loader.js")).href);
host.initTheme("dark", false);

function row(kind, text = kind, extra = {}) {
	return { info: { kind, ready: true, meaningful: true, ...extra }, render: () => [text], invalidate() {} };
}
const inspect = (item) => item.info;
const answer = () => row("assistant", "FINAL", { final: true });
const user = () => row("boundary", "USER");
function controller(inspector = inspect) {
	let renders = 0;
	const instance = new FoldController(inspector, (text, width) => tui.truncateToWidth(text, width), () => renders++);
	return { instance, renders: () => renders };
}
const renderRows = (rows, width = 120) => rows.flatMap((item) => item.render(width));
const click = (overrides = {}) => ({ type: "click", button: "left", x: 3, y: 1, screenX: 3, screenY: 1, width: 120, height: 2, shift: false, alt: false, ctrl: false, ...overrides });

function message(content, stopReason = "stop") {
	return { role: "assistant", content, stopReason, api: "openai-responses", provider: "test", model: "test", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const assistant = (text, stop = "stop") => new host.AssistantMessageComponent(message([{ type: "text", text }], stop), true);
const fakeUi = () => Object.assign(new tui.Container(), { requestRender() {} });
function nativeTool(ui, id = "tool-1", isError = false) {
	const item = new host.ToolExecutionComponent("sample", id, { path: "example" }, { showImages: false }, undefined, ui, extensionDir);
	item.updateResult({ content: [{ type: "text", text: "TOOL OUTPUT" }], isError }, false);
	return item;
}

// Pure planning/rendering regressions.
test("folds only intermediates and preserves the final answer and source rows", () => {
	const rows = [user(), row("assistant", "working"), row("tool", "output"), answer()];
	const originals = rows.map((item) => item.render);
	const { instance } = controller();
	instance.sync(rows);
	assert.equal(instance.groups.length, 1);
	assert.equal(instance.groups[0].tools, 1);
	assert.equal(instance.groups[0].messages, 1);
	assert.deepEqual(renderRows(rows).filter((line) => !line.includes("执行过程") && line), ["USER", "FINAL"]);
	assert.equal(rows.at(-1).render, originals.at(-1));
	instance.toggleLatest();
	assert.deepEqual(renderRows(rows).filter((line) => !line.includes("执行过程") && line), ["USER", "working", "output", "FINAL"]);
	instance.dispose();
	assert.deepEqual(rows.map((item) => item.render), originals);
	instance.dispose();
});

test("recovered provider/tool failures are counted, but terminal failures stay open", () => {
	const rows = [user(), row("assistant", "502", { failed: true }), row("tool", "bad", { failed: true }), answer()];
	const [group] = planGroups(rows, inspect);
	assert.equal(group.failures, 2);
	assert.match(summaryText(group), /2 条失败记录/);
	for (const failure of ["error", "aborted", "length", "empty"]) {
		assert.deepEqual(planGroups([user(), row("tool"), row("assistant", failure, { final: false })], inspect), []);
	}
});

test("does not fold unfinished tools, a tool after the answer, or direct answers", () => {
	assert.deepEqual(planGroups([user(), row("tool", "live", { ready: false }), answer()], inspect), []);
	assert.deepEqual(planGroups([user(), row("tool"), answer(), row("tool")], inspect), []);
	assert.deepEqual(planGroups([user(), answer()], inspect), []);
	assert.deepEqual(planGroups([user(), row("assistant", "", { meaningful: false }), answer()], inspect), []);
});

test("groups stay separated by user/custom/compaction boundaries; unknown output survives", () => {
	const unknown = { render: () => ["extension notice"], invalidate() {} };
	const rows = [user(), row("tool"), unknown, answer(), user(), row("tool"), answer()];
	const { instance } = controller();
	instance.sync(rows);
	assert.equal(instance.groups.length, 2);
	assert.ok(renderRows(rows).includes("extension notice"));
	assert.deepEqual(planGroups([user(), row("tool"), row("boundary", "compacted"), answer()], inspect), []);
	instance.dispose();
});

test("native shell folding excludes running commands and commands after the final answer", () => {
	const running = row("bash", "running", { ready: false });
	const trailing = row("bash", "after answer");
	const rows = [user(), row("bash", "done"), running, answer(), trailing];
	const [group] = planGroups(rows, inspect);
	assert.equal(group.tools, 1);
	assert.ok(!group.members.includes(running));
	assert.ok(!group.members.includes(trailing));
});

test("click expands only its group and forwards mouse coordinates after the heading", () => {
	let forwarded;
	const anchor = row("tool");
	anchor.handleMouse = (event) => { forwarded = event; return { handled: true }; };
	const { instance, renders } = controller();
	instance.sync([user(), anchor, answer(), user(), row("tool"), answer()]);
	assert.deepEqual(anchor.handleMouse(click()), { handled: true });
	assert.equal(instance.groups[0].expanded, true);
	assert.equal(instance.groups[1].expanded, false);
	assert.equal(renders(), 1);
	anchor.handleMouse(click({ type: "wheel", y: 3, height: 5, wheelDelta: 1 }));
	assert.equal(forwarded.y, 1);
	assert.equal(forwarded.height, 3);
	assert.equal(forwarded.wheelDelta, 1);
	anchor.handleMouse(click({ shift: true }));
	assert.equal(instance.groups[0].expanded, true);
	instance.dispose();
});

test("summary is width-safe in narrow terminals", () => {
	const rows = [row("tool"), answer()];
	const { instance } = controller();
	instance.sync(rows);
	for (const width of [1, 2, 5, 20, 80]) for (const line of rows[0].render(width)) assert.ok(tui.visibleWidth(line) <= width);
	assert.deepEqual(rows[0].render(0), []);
	instance.dispose();
});

test("preserves expansion across rescan, and new groups default to collapsed", () => {
	const rows = [user(), row("tool"), answer()];
	const { instance } = controller();
	instance.sync(rows);
	instance.toggleLatest();
	instance.sync([...rows, user(), row("tool"), answer()]);
	assert.deepEqual(instance.groups.map((group) => group.expanded), [true, false]);
	instance.setExpanded(true);
	assert.ok(instance.groups.every((group) => group.expanded));
	instance.dispose();
});

test("cleanup preserves inherited methods and later third-party wrappers", () => {
	const prototype = { render: () => ["native"], invalidate() {} };
	const anchor = Object.assign(Object.create(prototype), { info: { kind: "tool", ready: true } });
	const { instance } = controller();
	instance.sync([anchor, answer()]);
	const retained = anchor.render;
	const other = (width) => [...retained(width), "other extension"];
	anchor.render = other;
	instance.dispose();
	assert.equal(anchor.render, other);
	assert.deepEqual(anchor.render(100), ["native", "other extension"]);
	assert.equal(Object.hasOwn(anchor, "handleMouse"), false);
	const plain = Object.assign(Object.create(prototype), { info: { kind: "tool", ready: true } });
	instance.sync([plain, answer()]);
	instance.dispose();
	assert.equal(Object.hasOwn(plain, "render"), false);
});

test("partial wrapper installation fails open when a mouse method is read-only", () => {
	const anchor = row("tool", "native");
	const original = anchor.render;
	Object.defineProperty(anchor, "handleMouse", { value: () => undefined, writable: false });
	const { instance } = controller();
	assert.throws(() => instance.sync([anchor, answer()]), TypeError);
	instance.dispose();
	assert.equal(anchor.render, original);
	assert.deepEqual(anchor.render(100), ["native"]);
});

// Adapter regressions exercise the actual installed Pi component classes.
test("real host components expose the guarded metadata and retain their native rendering", () => {
	const ui = fakeUi();
	const tool = nativeTool(ui);
	const final = assistant("Final answer");
	const error = assistant("", "error");
	const live = assistant("Still streaming");
	live.updateContent(message([{ type: "text", text: "Still streaming" }]), true);
	assert.equal(inspectRow(final).final, true);
	assert.equal(inspectRow(error).failed, true);
	assert.equal(inspectRow(live).final, false);
	assert.equal(inspectRow(tool).ready, true);
	const source = tool.render(100);
	const { instance } = controller(inspectRow);
	instance.sync([new host.UserMessageComponent("question"), error, tool, final]);
	assert.equal(instance.groups.length, 1);
	assert.deepEqual(tool.render(100), []);
	instance.setExpanded(true);
	assert.deepEqual(tool.render(100), source);
	instance.dispose();
	delete tool.isPartial;
	assert.equal(inspectRow(tool).kind, "boundary");
});

const delegateNotice = (status = "completed", id = "del_smoke_1") =>
	`[acp_delegate ${status}] **researcher** (runId \`${id}\`, exit ${status === "completed" ? 0 : 1}) No delegates are currently running.\n\n`
	+ "This is an automated system notification, NOT a user message.\n\nTask: Investigate a fixture\n\n"
	+ `Full result: \`/tmp/acp-delegate/${id}.out\`\n(use the \`read\` tool to open it if you need the details)\n`;

test("persisted delegate notifications do not split a completed execution group", () => {
	const ui = fakeUi();
	const first = nativeTool(ui, "before-notice");
	const notice = new host.UserMessageComponent(delegateNotice());
	const failed = new host.UserMessageComponent(delegateNotice("FAILED ⚠️", "del_smoke_2"));
	const second = nativeTool(ui, "after-notice");
	const final = assistant("final answer");
	const originals = [notice, failed, final].map((item) => item.render(120));
	const { instance } = controller(inspectRow);
	instance.sync([new host.UserMessageComponent("actual question"), first, notice, failed, second, final]);
	assert.equal(instance.groups.length, 1);
	assert.equal(instance.groups[0].tools, 2);
	assert.equal(instance.groups[0].messages, 2);
	assert.equal(instance.groups[0].failures, 1);
	assert.match(first.render(120).join("\n"), /执行过程/);
	assert.deepEqual(notice.render(120), []);
	assert.deepEqual(failed.render(120), []);
	assert.deepEqual(second.render(120), []);
	assert.deepEqual(final.render(120), originals[2]);
	instance.setExpanded(true);
	assert.deepEqual(notice.render(120), originals[0]);
	assert.deepEqual(failed.render(120), originals[1]);
	instance.dispose();
});

test("user questions quoting notification headings remain real boundaries", () => {
	const full = delegateNotice();
	for (const text of [full.split("\n")[0], `请解释：${full}`, `${full}我该怎么办？`,
		full.replace("/del_smoke_1.out", "/del_another_run.out"), "[acp_delegate completed] hello"]) {
		assert.equal(inspectRow(new host.UserMessageComponent(text)).kind, "boundary");
	}
});

test("notifications remain visible when execution has not successfully finished", () => {
	const notice = new host.UserMessageComponent(delegateNotice());
	const source = notice.render(120);
	const { instance } = controller(inspectRow);
	instance.sync([nativeTool(fakeUi()), notice, assistant("", "error")]);
	assert.equal(instance.groups.length, 0);
	assert.deepEqual(notice.render(120), source);
	instance.dispose();
});

test("real native bash commands restore their output and cancelled runs remain diagnosable", () => {
	const ui = fakeUi();
	const bash = new host.BashExecutionComponent("printf test", ui);
	try {
		assert.equal(inspectRow(bash).ready, false);
		bash.appendOutput("shell output\n");
		bash.setComplete(0, false);
		assert.equal(inspectRow(bash).ready, true);
		const original = bash.render(100);
		const { instance } = controller(inspectRow);
		instance.sync([bash, assistant("done")]);
		assert.match(bash.render(100).join("\n"), /执行过程/);
		instance.setExpanded(true);
		assert.deepEqual(bash.render(100).slice(2), original);
		instance.dispose();
	} finally {
		bash.setComplete(undefined, true);
	}
	assert.equal(inspectRow(bash).failed, true);
});

test("folding hides the whole tool row including independent image components", () => {
	const renderer = { renderShell: "self", renderCall: () => new tui.Text("call", 0, 0), renderResult: () => new tui.Text("result", 0, 0) };
	const tool = new host.ToolExecutionComponent("image", "image-1", {}, { showImages: true }, renderer, fakeUi(), extensionDir);
	tool.updateResult({ content: [{ type: "text", text: "output" }], isError: false }, false);
	// Native ToolExecutionComponent appends images independently of self-renderers.
	tool.imageComponents = [{ render: () => ["IMAGE PAYLOAD"], invalidate() {} }];
	tool.imageSpacers = [{ render: () => [""], invalidate() {} }];
	assert.match(tool.render(120).join("\n"), /IMAGE PAYLOAD/);
	const { instance } = controller(inspectRow);
	instance.sync([tool, assistant("done")]);
	assert.doesNotMatch(tool.render(120).join("\n"), /IMAGE PAYLOAD/);
	instance.setExpanded(true);
	assert.match(tool.render(120).join("\n"), /IMAGE PAYLOAD/);
	instance.dispose();
});

test("finds nested transcript but does not traverse non-component arbitrary fields", () => {
	const root = new tui.Container();
	const document = new tui.Container();
	const chat = new tui.Container();
	root.addChild(document);
	document.addChild(chat);
	chat.addChild(new host.UserMessageComponent("hello"));
	chat.addChild(assistant("answer"));
	assert.equal(findTranscript(root), chat.children);
	assert.equal(findTranscript({ render: () => [], invalidate() {}, secret: chat }), undefined);
});

test("bridge catches delayed host rebuilds and refresh requests while compaction is busy", async () => {
	const loaded = await loadExtensions([path.join(extensionDir, "index.ts")], extensionDir);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const ui = fakeUi();
	const chat = new tui.Container();
	ui.addChild(chat);
	let bridge;
	let idle = true;
	const ctx = { mode: "tui", isIdle: () => idle, ui: { theme: { fg: (_color, text) => text }, notify() {}, setWidget: (_id, factory) => { bridge = factory?.(ui); } } };
	const emit = async (name) => { for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name }, ctx); };
	const replaceTranscript = (id) => {
		chat.clear();
		const tool = nativeTool(ui, id);
		chat.addChild(new host.UserMessageComponent(id));
		chat.addChild(tool);
		chat.addChild(assistant("final"));
		return tool;
	};
	const first = replaceTranscript("first");
	await emit("session_start");
	await delay(10);
	assert.match(first.render(120).join("\n"), /执行过程/);
	try {
		await emit("session_tree");
		await delay(10); // another extension awaits I/O before the host can rebuild
		const second = replaceTranscript("second");
		assert.match(second.render(120).join("\n"), /TOOL OUTPUT/);
		bridge.render(120); // first real frame after the delayed host rebuild
		await delay(10);
		assert.match(second.render(120).join("\n"), /执行过程/);
		idle = false;
		const third = replaceTranscript("third");
		await emit("session_compact");
		await delay(10);
		assert.match(third.render(120).join("\n"), /TOOL OUTPUT/);
		idle = true;
		bridge.render(120);
		await delay(10);
		assert.match(third.render(120).join("\n"), /执行过程/);
		assert.match(first.render(120).join("\n"), /TOOL OUTPUT/); // detached rows restored
		assert.match(second.render(120).join("\n"), /TOOL OUTPUT/);
	} finally {
		await emit("session_shutdown");
	}
});

test("actual Pi loader, settled lifecycle, commands, reload cleanup, and non-TUI guard", async () => {
	const loaded = await loadExtensions([path.join(extensionDir, "index.ts")], extensionDir);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.equal(extension.tools.size, 0);
	assert.equal(extension.handlers.has("message_end"), false);
	assert.equal(extension.handlers.has("context"), false);
	assert.equal(extension.handlers.has("agent_end"), false);
	assert.ok(extension.shortcuts.has("alt+o"));
	let idle = true;
	let bridge;
	const notifications = [];
	const ui = fakeUi();
	const chat = new tui.Container();
	ui.addChild(chat);
	const tool = nativeTool(ui);
	const original = tool.render;
	chat.addChild(new host.UserMessageComponent("hello"));
	chat.addChild(tool);
	chat.addChild(assistant("final"));
	const ctx = { mode: "tui", isIdle: () => idle, ui: { theme: { fg: (_color, text) => text }, notify: (text) => notifications.push(text), setWidget: (_id, factory) => { bridge = factory?.(ui); } } };
	const emit = async (name, extra = {}) => { for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name, ...extra }, ctx); };
	const command = (args) => extension.commands.get("fold").handler(args, ctx);
	await emit("session_start", { reason: "startup" });
	assert.deepEqual(bridge.render(80), []);
	await delay(10);
	assert.notEqual(tool.render, original);
	assert.match(tool.render(120).join("\n"), /执行过程/);
	await command("");
	assert.match(tool.render(120).join("\n"), /TOOL OUTPUT/);
	await command("off");
	assert.equal(tool.render, original);
	await command("on");
	assert.notEqual(tool.render, original);
	// Active progress remains visible. A low-level agent_end cannot collapse it.
	idle = false;
	await emit("agent_start");
	const nextTool = nativeTool(ui, "tool-2");
	chat.addChild(new host.UserMessageComponent("next"));
	chat.addChild(nextTool);
	chat.addChild(assistant("next final"));
	await emit("agent_end");
	assert.match(nextTool.render(120).join("\n"), /TOOL OUTPUT/);
	idle = true;
	await emit("agent_settled", { aborted: false });
	await delay(10);
	assert.match(nextTool.render(120).join("\n"), /执行过程/);
	await command("expand");
	assert.match(nextTool.render(120).join("\n"), /TOOL OUTPUT/);
	await command("collapse");
	await command("status");
	assert.match(notifications.at(-1), /2 组/);
	await emit("session_shutdown", { reason: "reload" });
	assert.equal(tool.render, original);
	assert.equal(bridge, undefined);
	await emit("session_start", { reason: "reload" });
	await emit("session_shutdown", { reason: "quit" });
	await delay(10);
	assert.equal(tool.render, original); // pending startup scan was cancelled
	for (const mode of ["rpc", "print", "json"]) {
		ctx.mode = mode;
		ctx.ui.setWidget = () => { throw new Error("non-TUI widget access"); };
		await emit("session_start", { reason: "startup" });
		await emit("agent_settled", { aborted: false });
		await command("on");
		await emit("session_shutdown", { reason: "quit" });
	}
});
