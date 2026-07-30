import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_ID = "scroll-chat-status";

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1)}k` : `${tokens}`;
}

function scrollBorder(label: string, width: number, border: (text: string) => string, fill: (text: string) => string): string {
	if (width <= 0) return "";
	if (width < 5) return border("═".repeat(width));

	const start = border("◜═");
	const end = border("═◝");
	const available = Math.max(0, width - visibleWidth(start) - visibleWidth(end));
	const title = truncateToWidth(label, available, "");
	return start + title + fill("═".repeat(Math.max(0, available - visibleWidth(title)))) + end;
}

function contextMeter(ctx: ExtensionContext): { label: string; used: string; unused: string } {
	const usage = ctx.getContextUsage();
	const barWidth = 12;
	if (!usage || usage.tokens === null || usage.percent === null) {
		return { label: "Context remaining: calculating…", used: "", unused: "░".repeat(barWidth) };
	}

	const remaining = Math.max(0, usage.contextWindow - usage.tokens);
	const usedPercent = Math.max(0, Math.min(100, usage.percent));
	const remainingPercent = 100 - usedPercent;
	const usedWidth = Math.round((usedPercent / 100) * barWidth);
	return {
		label: `Context remaining: ${remainingPercent.toFixed(0)}% · used ${usedPercent.toFixed(0)}%`,
		used: "█".repeat(usedWidth),
		unused: "░".repeat(barWidth - usedWidth),
	};
}

export default function (pi: ExtensionAPI) {
	let tui: TUI | undefined;

	const requestRender = () => tui?.requestRender();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setWidget(WIDGET_ID, (_tui, theme): Component => ({
			render(width: number): string[] {
				const provider = ctx.model?.provider ?? "no provider";
				const model = ctx.model?.id ?? "no model";
				const thinking = ctx.thinkingLevel;
				const meter = contextMeter(ctx);
				const status = ` ${provider} | ${model} | thinking: ${thinking} `;
				const contextLine = truncateToWidth(
					theme.fg("muted", "  " + meter.label + "  [") +
					theme.fg("warning", meter.used) +
					theme.fg("dim", meter.unused + "]"),
					width,
				);
				const modelInfo = truncateToWidth(theme.fg("accent", "✦") + theme.bold(status), width);
				return [contextLine, "", modelInfo];
			},
			invalidate() {},
		}), { placement: "belowEditor" });

		class ScrollEditor extends CustomEditor {
			constructor(tuiInstance: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tuiInstance, theme, keybindings, { paddingX: 1 });
				tui = tuiInstance;
			}

			render(width: number): string[] {
				const lines = super.render(width);
				if (lines.length < 2) return lines;

				const theme = ctx.ui.theme;
				const topLabel = "";
				const bottomLabel = "";
				const border = (text: string) => this.borderColor(text);
				const fill = (text: string) => theme.fg("borderMuted", text);
				lines[0] = scrollBorder(topLabel, width, border, fill);
				lines[lines.length - 1] = scrollBorder(bottomLabel, width, border, fill);
				return lines;
			}
		}

		ctx.ui.setEditorComponent((tuiInstance, theme, keybindings) =>
			new ScrollEditor(tuiInstance, theme, keybindings),
		);
		requestRender();
	});

	pi.on("model_select", requestRender);
	pi.on("thinking_level_select", requestRender);
	pi.on("message_start", requestRender);
	pi.on("message_update", requestRender);
	pi.on("message_end", requestRender);
	pi.on("turn_end", requestRender);
	pi.on("session_shutdown", () => {
		tui = undefined;
	});
}
