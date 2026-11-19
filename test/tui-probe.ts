/** Loaded only by tui-smoke.py into an isolated real Pi CLI process. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { findTranscript, inspectRow } from "../index.ts";

export default function probe(pi: ExtensionAPI): void {
	let tui: TUI | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const snapshot = (label: string) => {
		const directory = process.env.AUTO_FOLD_SMOKE_DIR;
		if (!directory || !/^[a-z]+$/u.test(label)) throw new Error("Invalid smoke test destination");
		const rows = tui ? findTranscript(tui) ?? [] : [];
		const rendered = rows.map((row) => ({ info: inspectRow(row), lines: row.render(120) }));
		writeFileSync(join(directory, `${label}.json`), JSON.stringify({
			rows: rows.length,
			boundaries: rendered.filter((row) => row.info?.kind === "boundary").map((row) => row.lines),
			tools: rendered.filter((row) => row.info?.kind === "tool").map((row) => row.lines),
			notices: rendered.filter((row) => row.info?.kind === "notice").map((row) => row.lines),
			finals: rendered.filter((row) => row.info?.final).map((row) => row.lines),
			summaries: rendered.flatMap((row) => row.lines).filter((line) => line.includes("执行过程：")),
		}));
	};
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWidget("auto-fold:smoke-probe", (ui) => {
			tui = ui;
			return { render: () => [], invalidate: () => {} };
		});
		timer = setTimeout(() => snapshot("startup"), 500);
	});
	pi.on("session_shutdown", () => {
		if (timer !== undefined) clearTimeout(timer);
		tui = undefined;
	});
	pi.registerCommand("fold-smoke", { description: "Private test probe", handler: async (label) => snapshot(label) });
}
