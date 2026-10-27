/**
 * QQ 侧「桌面命令」：在 QQ 里用终端里的那套命令。
 *
 * 为什么需要它：Pi 的内置斜杠命令（/model、/new、/compact…）只在 TUI 里执行，
 * RPC/后台模式里发出去会被当成普通提问喂给模型。这里把常用命令映射到扩展 API，
 * 行为与终端一致，回答以纯文本回到 QQ。
 *
 * 只有 /new 需要「命令上下文」（ExtensionCommandContext.newSession 只能在命令里调），
 * 由 index.js 通过注入一句扩展命令来执行，其余都是直接的扩展 API 调用。
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 由本模块处理的命令：命中就不进模型。 */
export const QQ_SIDE = new Set(["new", "model", "thinking", "compact", "session", "name", "tools", "help"]);

/**
 * Pi 的 TUI 专用内置命令：QQ 里没有等价实现，明确拒绝比当成提问喂给模型好。
 * 需要扩展上下文才能做的（/resume /fork /tree /export）留到后续版本。
 */
export const TUI_ONLY = new Set([
	"settings",
	"scoped-models",
	"login",
	"logout",
	"llama",
	"resume",
	"tree",
	"fork",
	"clone",
	"import",
	"copy",
	"export",
	"share",
	"bug",
	"trust",
	"reload",
	"hotkeys",
	"changelog",
	"quit",
]);

export const HELP_TEXT = [
	"QQ 里的命令（与终端一致）：",
	"  /new [名称]      开新会话",
	"  /model           列模型；/model 3 或 /model provider/id 切换",
	"  /thinking        看思考级别；/thinking high 切换",
	"  /compact [说明]  压缩上下文",
	"  /session         模型、思考级别、上下文用量、会话名",
	"  /name [名称]     设置会话名",
	"  /tools           当前启用的工具",
	"  /help            这张表",
	"",
	"技能、提示模板和其它插件的命令（如 /skill:a-stock-data）直接发即可。",
	"插件自身的命令：/qq status、/qq log（start/stop/take 要在终端执行）。",
].join("\n");

/** `/model 3`、`/thinking high  ` → {name, args, raw}；不是命令返回 null。 */
export function parseCommand(text) {
	const trimmed = String(text ?? "").trim();
	if (!trimmed.startsWith("/")) return null;
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return null;
	return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim(), raw: trimmed };
}

function modelLabel(model) {
	const provider = model?.provider ?? "?";
	const id = model?.id ?? model?.modelId ?? "?";
	const name = model?.name && model.name !== id ? `（${model.name}）` : "";
	return `${provider}/${id}${name}`;
}

function formatTokens(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return String(value ?? "?");
	return n.toLocaleString("en-US");
}

/**
 * @param {object} deps
 * @param {() => any} deps.getPi 取当前扩展 API（换会话后扩展工厂会重跑，句柄要现取）
 * @param {() => any} deps.getCtx 取当前扩展上下文（换会话后会刷新）
 * @param {(args: string) => Promise<{ok: boolean, cancelled?: boolean, message?: string}>} deps.newSession
 * @param {(msg: string, level?: string) => void} [deps.notify]
 */
export function createCommandRunner({ getPi, getCtx, newSession, notify }) {
	/** 上一次 /model 列出的清单，供 `/model 3` 用 */
	let listed = [];
	let listedAt = 0;
	const LIST_TTL = 5 * 60 * 1000;

	function ctx() {
		return getCtx?.();
	}

	function api() {
		return getPi?.();
	}

	function currentModel() {
		const c = ctx();
		return c?.model ?? api()?.model;
	}

	async function listModels() {
		const c = ctx();
		const all = c?.modelRegistry?.getAvailable?.() ?? [];
		const models = Array.isArray(all) ? all : [];
		listed = models.slice(0, 20);
		listedAt = Date.now();
		if (listed.length === 0) return "没有可用的模型（检查认证：终端里 /login）";
		const current = currentModel();
		const lines = listed.map((model, index) => {
			const mark = current && model.provider === current.provider && model.id === current.id ? " ← 当前" : "";
			return `${index + 1}. ${modelLabel(model)}${mark}`;
		});
		return [`可选模型（共 ${models.length} 个，列出前 ${listed.length} 个）：`, ...lines, "", "切换：/model 序号 或 /model provider/id"].join(
			"\n",
		);
	}

	async function selectModel(arg) {
		const c = ctx();
		const registry = c?.modelRegistry;
		if (!registry) return "当前上下文拿不到模型清单（等 Pi 空闲后再试）";
		const all = registry.getAvailable?.() ?? [];
		const wanted = String(arg ?? "").trim();
		if (!wanted) return listModels();
		if (/^\d+$/.test(wanted)) {
			const index = Number(wanted) - 1;
			if (!listed.length || Date.now() - listedAt > LIST_TTL) {
				await listModels();
			}
			const model = listed[index];
			if (!model) return `序号超出范围：先发 /model 看清单（1-${listed.length}）`;
			const ok = await api().setModel(model);
			return ok ? `已切换到 ${modelLabel(model)}` : `切换失败：${modelLabel(model)} 没有配置认证`;
		}
		const slash = wanted.indexOf("/");
		const provider = slash > 0 ? wanted.slice(0, slash) : undefined;
		const id = slash > 0 ? wanted.slice(slash + 1) : wanted;
		const exact = all.find((model) => model.id === id && (!provider || model.provider === provider));
		const fuzzy = exact ?? all.find((model) => model.id === id || model.id.includes(id));
		if (!fuzzy) return `没找到模型：${wanted}。先发 /model 看清单`;
		const ok = await api().setModel(fuzzy);
		return ok ? `已切换到 ${modelLabel(fuzzy)}` : `切换失败：${modelLabel(fuzzy)} 没有配置认证`;
	}

	function thinkingReport() {
		const current = api()?.getThinkingLevel?.() ?? "unknown";
		return `思考级别：${current}\n可选：${THINKING_LEVELS.join(" / ")}\n切换：/thinking high`;
	}

	function setThinking(level) {
		const wanted = String(level ?? "").trim().toLowerCase();
		if (!wanted) return thinkingReport();
		if (!THINKING_LEVELS.includes(wanted)) return `不认识的级别：${wanted}\n可选：${THINKING_LEVELS.join(" / ")}`;
		api().setThinkingLevel(wanted);
		const now = api().getThinkingLevel?.() ?? wanted;
		return now === wanted ? `思考级别已设为 ${now}` : `已请求 ${wanted}，当前生效的是 ${now}（受模型能力限制）`;
	}

	function sessionReport() {
		const c = ctx();
		const model = currentModel();
		const lines = [];
		lines.push(`模型：${model ? modelLabel(model) : "未选择"}`);
		lines.push(`思考级别：${api()?.getThinkingLevel?.() ?? "unknown"}`);
		let usage;
		try {
			usage = c?.getContextUsage?.();
		} catch {
			usage = undefined;
		}
		if (usage) {
			const tokens = usage.tokens ?? usage.usedTokens;
			const window = usage.contextWindow ?? usage.maxTokens;
			const percent = usage.percent;
			lines.push(
				`上下文：${formatTokens(tokens)} / ${formatTokens(window)}${Number.isFinite(percent) ? `（${Math.round(percent)}%）` : ""}`,
			);
		}
		const manager = c?.sessionManager;
		const id = manager?.getSessionId?.();
		const name = api()?.getSessionName?.() ?? manager?.getSessionName?.();
		if (id) lines.push(`会话：${id}${name ? ` · ${name}` : ""}`);
		if (manager?.getSessionFile?.()) lines.push(`文件：${manager.getSessionFile()}`);
		if (c?.cwd) lines.push(`目录：${c.cwd}`);
		const tools = api()?.getActiveTools?.() ?? [];
		if (tools.length) lines.push(`工具：${tools.length} 个`);
		return lines.join("\n");
	}

	function toolsReport() {
		const tools = api()?.getActiveTools?.() ?? [];
		if (tools.length === 0) return "当前没有启用的工具";
		return [`当前启用 ${tools.length} 个工具：`, ...tools.sort()].join("\n");
	}

	function nameCommand(arg) {
		const wanted = String(arg ?? "").trim();
		if (!wanted) {
			const current = api()?.getSessionName?.();
			return current ? `会话名：${current}` : "会话还没有名字。设置：/name 潮汐投资";
		}
		api().setSessionName(wanted);
		return `会话名已设为 ${wanted}`;
	}

	function compactCommand(arg) {
		const c = ctx();
		if (!c?.compact) return "当前上下文不支持压缩（等 Pi 空闲后再试）";
		c.compact(arg ? { customInstructions: arg } : undefined);
		return arg ? `已开始压缩上下文（附加说明：${arg}）` : "已开始压缩上下文";
	}

	/**
	 * 执行一条命令，返回要给 QQ 的纯文本。
	 * 返回 null 表示「不是本模块处理的命令」，交给上层（转发给 Pi 或拒绝）。
	 */
	async function run(command) {
		const { name, args } = command;
		if (!QQ_SIDE.has(name)) return null;
		switch (name) {
			case "new": {
				const result = await newSession(args);
				if (result?.cancelled) return "开新会话被取消";
				if (!result?.ok) return `开新会话失败：${result?.message ?? "未知原因"}`;
				return args ? `✅ 已开新会话（${args}）` : "✅ 已开新会话";
			}
			case "model":
				return args ? selectModel(args) : listModels();
			case "thinking":
				return setThinking(args);
			case "compact":
				return compactCommand(args);
			case "session":
				return sessionReport();
			case "name":
				return nameCommand(args);
			case "tools":
				return toolsReport();
			case "help":
				return HELP_TEXT;
			default:
				return null;
		}
	}

	return { run, listModels, reset: () => (listed = []) };
}
