/**
 * pi-qq-connect：把 QQ 官方机器人接到当前 Pi 会话。
 *
 * QQ 里发的文字 → pi.sendUserMessage() → Pi 干完活 → 最终 assistant 文本被动回复到 QQ。
 * 所有消息都进同一个 Pi 会话，所以上下文是连续的。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configPath, loadConfig } from "./config.js";
import {
	describeService,
	isProcessAlive,
	isServiceAlive,
	readServiceState,
	removeServiceState,
	serviceStatePath,
	startService,
	stopService,
} from "./service.js";
import { Logger } from "./log.js";
import { QqAuth } from "./auth.js";
import { QqApi } from "./api.js";
import { QqGateway } from "./gateway.js";
import { QqBridge, isStaleContextError } from "./session.js";
import { acquireLock, readLock, releaseLock } from "./lock.js";
import { maskId, normalizeEvent } from "./text.js";
import { HELP_TEXT, TUI_ONLY, createCommandRunner } from "./commands.js";

const SERVICE_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-qq-connect.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseDir() {
	return path.dirname(configPath());
}

/** AppID 是 9~10 位数字，maskId 对短 ID 不掩码，这里单独处理。 */
function maskAppId(id) {
	const text = String(id ?? "");
	if (text.length <= 6) return "***";
	return `${text.slice(0, 4)}***${text.slice(-3)}`;
}

function lockFilePath() {
	return path.join(baseDir(), "pi-qq-connect.lock");
}

const STATE_LABEL = {
	idle: "未启动",
	connecting: "连接中",
	connected: "在线",
	disconnected: "重连中",
	error: "出错",
	stopped: "已停止",
	disabled: "已关闭",
	unconfigured: "未配置",
	locked: "被占用",
};

const RUNTIME_KEY = Symbol.for("pi-qq-connect.runtime.v1");
const root = globalThis;

function newRuntime() {
	return {
		ctx: undefined,
		extensionApi: undefined,
		config: undefined,
		logger: undefined,
		gateway: undefined,
		bridge: undefined,
		error: null,
		starting: false,
		startPending: undefined,
		owner: undefined,
		sessionCtx: undefined,
		lastInbound: undefined,
		lockWatch: undefined,
		runner: undefined,
		pendingExec: undefined,
	};
}

// Pi 在 /new、/resume、/fork 时会重新执行扩展工厂；状态放进程级单例，
// 否则第二次会再连一条网关、抢一次锁。
const shared = root[RUNTIME_KEY] ?? (root[RUNTIME_KEY] = newRuntime());

/** 测试用：彻底清掉进程内状态。 */
export function resetRuntimeForTests() {
	shared.bridge?.stop?.();
	shared.gateway?.stop?.();
	if (shared.lockWatch) clearInterval(shared.lockWatch);
	Object.assign(shared, newRuntime());
	delete shared.seenInstances;
}

export default function createExtension(pi) {
	const state = shared;
	// Pi 每换一次会话（/new、/resume、/fork、/reload）都会用新的 pi 句柄重跑扩展工厂，
	// 旧句柄随即永久作废。状态仍用进程级单例，但事件与命令必须按实例注册：
	// 否则新实例什么都不注册——/qq 等命令消失、session_start 收不到、
	// 桥只能在 30 秒看门狗超时后误判「桥失效」。
	state.extensionApi = pi;
	if (state.bridge) state.bridge.pi = pi;
	// 同一个对象被加载两次（自动发现 + 显式 --extension 命中同一路径）：别再注册一遍
	const seen = (state.seenInstances ??= new WeakSet());
	if (seen.has(pi)) return state;
	seen.add(pi);

	// 但同一个会话里被加载两次时，pi 也可能是两个不同的对象。同一个事件会带同一个 ctx，
	// 所以再按 ctx 选举负责人，只让一个实例处理事件，避免一条 QQ 消息被回复两次。

	function setStatus(label, detail) {
		const text = detail ? `QQ: ${label} · ${detail}` : `QQ: ${label}`;
		try {
			state.ctx?.ui?.setStatus?.("qqbot", text);
		} catch {
			// 非 TUI 模式可能没有状态栏
		}
	}

	function notify(message, level = "info") {
		state.logger?.[level === "warning" ? "warn" : level === "error" ? "error" : "info"](message);
		try {
			state.ctx?.ui?.notify?.(message, level);
		} catch {
			// 没有 UI 时只落日志
		}
	}

	/**
	 * 当前进程是不是状态文件里那个后台服务（bin 会注入 PIQQCONNECT_SERVICE_PID）。
	 * 同时检查 ppid：这个环境变量会被服务里的工具子进程继承，只看 pid 会把孙进程也当成服务。
	 */
	function isServiceProcess(service) {
		return Boolean(
			process.env.PIQQCONNECT_SERVICE_PID &&
				service &&
				String(service.pid) === process.env.PIQQCONNECT_SERVICE_PID &&
				process.ppid === service.pid,
		);
	}

	function stop({ release = true } = {}) {
		if (state.lockWatch) {
			clearInterval(state.lockWatch);
			state.lockWatch = undefined;
		}
		if (state.pendingExec) {
			state.pendingExec.done({ ok: false, message: "后台服务已停止" });
			state.pendingExec = undefined;
		}
		try {
			state.gateway?.stop();
		} catch {
			// ignore
		}
		state.bridge?.stop();
		state.gateway = undefined;
		state.bridge = undefined;
		if (release && state.config?.lock !== false) releaseLock(lockFilePath());
	}

	/** 开新会话：失败只提示，不打断当前会话；返回值给 QQ 侧回执用。 */
	async function switchSession(ctx, name = "") {
		const label = String(name ?? "").trim();
		try {
			const result = await ctx.newSession({
				setup: async (sessionManager) => {
					if (label) sessionManager.appendSessionInfo(label);
				},
				// 换会话后旧 ctx 立即作废：用 pi 提供的替换后上下文刷新提示/状态栏目标
				withSession: (next) => {
					state.ctx = next;
				},
			});
			if (result?.cancelled) {
				notify("开新会话被取消", "warning");
				return { ok: false, cancelled: true, message: "被取消" };
			}
			return { ok: true };
		} catch (err) {
			if (isStaleContextError(err)) {
				// 旧句柄已失效：新会话其实已经开成，出问题的是桥
				return { ok: false, message: "当前 pi 会话句柄已作废，请 /qq stop 再 /qq start 重启后台服务" };
			}
			return { ok: false, message: err?.message ?? String(err) };
		}
	}

	/**
	 * 让 QQ 侧也能开新会话：ExtensionCommandContext.newSession 只能在命令处理器里调，
	 * 所以借一句扩展命令 `/qq __new` 走过去，命令执行完直接把结果 resolve 回来——
	 * 旧版是靠 15 秒轮询猜的，常常「假失败」。
	 */
	function requestNewSession(args = "") {
		if (state.pendingExec) {
			// 连发两次 /new 时别互相踩：后一个直接拒绝，避免把前一个的暂存队列解开
			return Promise.resolve({ ok: false, message: "上一个开新会话还在进行中，稍等一下" });
		}
		return new Promise((resolve) => {
			let settled = false;
			const done = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				const owner = state.pendingExec?.done === done;
				const pending = state.pendingExec;
				if (owner) state.pendingExec = undefined;
				// 失败/取消：如果这次确实已经开始换会话（见过 session_shutdown），就交给看门狗与接棒；
				// 纯失败（被取消、报错、超时且根本没换）必须立刻把暂存队列放回去，别让整桥停 30 秒
				if (!result?.ok && owner && !pending?.sawShutdown) state.bridge?.cancelSwitch();
				resolve(result);
			};
			// 略长于 session.js 的 30 秒切换看门狗：看门狗先恢复队列，这里再清掉 pendingExec，
			// 免得用户在 31~60 秒之间发 /new 还被「上一个还在进行中」挡住
			const timer = setTimeout(() => done({ ok: false, message: "Pi 35 秒内没有完成会话切换（可能正忙）" }), 35_000);
			timer.unref?.();
			state.pendingExec = { done };
			state.bridge?.beginSwitch();
			try {
				state.extensionApi.sendUserMessage(args ? `/qq __new ${args}` : "/qq __new", { expandPromptTemplates: true });
			} catch (err) {
				state.bridge?.cancelSwitch();
				done({ ok: false, message: err?.message ?? String(err) });
			}
		});
	}

	/** QQ 里发来的斜杠命令：本插件处理 / 桌面命令 / 拒绝 TUI 专用命令 / 转发给 Pi。 */
	async function handleCommand(command) {
		if (command.name === "qq") return { text: handleQqSubcommand(command.args) };
		const local = await state.runner?.run(command);
		if (local !== null && local !== undefined) return { text: local };
		if (TUI_ONLY.has(command.name)) {
			return { text: `「/${command.name}」只能在终端里用。QQ 里可用：/new /model /thinking /compact /session /name /tools /help` };
		}
		let known = false;
		try {
			known = (state.extensionApi?.getCommands?.() ?? []).some((item) => item.name === command.name);
		} catch {
			known = false;
		}
		if (known) return { forward: true };
		return { text: `不认识的命令 /${command.name}。发 /help 看 QQ 里能用的命令。` };
	}

	/** /qq 在 QQ 里只回放能纯文本回答的子命令，改机器状态的仍留给终端。 */
	function handleQqSubcommand(args) {
		const [sub, ...rest] = String(args ?? "").trim().split(/\s+/);
		switch (sub || "status") {
			case "status":
				return statusReport();
			case "log": {
				const n = Number(rest[0]) > 0 ? Math.min(Number(rest[0]), 200) : 20;
				return state.logger?.tail(n)?.join("\n") ?? "（没有日志）";
			}
			case "help":
				return HELP_TEXT;
			case "new":
				return "「/qq new」已并入「/new」，直接发 /new 即可";
			default:
				return `「/qq ${sub}」要在终端里执行（会用终端切换到前后台服务）。QQ 里可用：/qq status、/qq log [n]`;
		}
	}

	async function start(ctx, { keepLock = false } = {}) {
		if (state.starting) {
			// 正在起：记下这次的 ctx，等这一轮结束后再跑一次，别把新会话的 session_start 丢掉
			state.startPending = ctx ?? state.startPending;
			return;
		}
		state.starting = true;
		state.ctx = ctx ?? state.ctx;
		try {
			// 自己先让出网关和锁；/qq take 传 keepLock 时保留刚强占的锁
			stop({ release: !keepLock });
			state.error = null;
			state.lastInbound = undefined;

			const { config, path: configFile, exists, warnings, error } = loadConfig();
			state.config = config;
			state.logger = new Logger(config.log);

			if (!exists || error) {
				state.error = error;
				setStatus(STATE_LABEL.unconfigured, path.basename(configFile));
				notify(`pi-qq-connect: ${error}\n示例配置见项目内 examples/config.json`, "warning");
				return;
			}
			for (const warning of warnings) notify(`pi-qq-connect: ${warning}`, "info");

			if (!config.enabled) {
				setStatus(STATE_LABEL.disabled);
				notify("pi-qq-connect: 配置里 enabled=false，未连接", "info");
				return;
			}

			// 后台常驻服务在线时，本进程只当控制面，不抢网关
			const serviceFile = serviceStatePath(baseDir());
			const service = readServiceState(serviceFile);
			const serviceAlive = Boolean(service && isServiceAlive(service));
			const iAmService = isServiceProcess(service);
			if (serviceAlive && !iAmService) {
				setStatus("服务在线", `pid ${service.pid}`);
				notify(`pi-qq-connect: 后台服务在线（pid ${service.pid}），本进程不连网关。用 /qq status 查看`, "info");
				return;
			}

			if (config.lock) {
				let lock = acquireLock(lockFilePath());
				// 旧服务/上一个进程可能还在收尾，给它几秒释放锁，别让服务起来却永远连不上
				for (let attempt = 0; !lock.ok && attempt < 4; attempt++) {
					await sleep(1000);
					lock = acquireLock(lockFilePath());
				}
				if (!lock.ok) {
					state.error = `网关已被另一个 Pi 进程持有（pid ${lock.holder?.pid}）`;
					setStatus(STATE_LABEL.locked, `pid ${lock.holder?.pid}`);
					notify(`pi-qq-connect: ${state.error}。关掉那个进程，或在终端运行 /qq take 强制接管。`, "warning");
					return;
				}
				if (lock.takenOver) notify("pi-qq-connect: 已强制接管网关", "info");
				// 别的进程 /qq take 后，这里要让出网关，否则两个进程各收一半消息
				state.lockWatch = setInterval(() => {
					const holder = readLock(lockFilePath());
					if (holder && holder.pid !== process.pid) {
						notify(`pi-qq-connect: 网关已被 pid ${holder.pid} 接管，本进程断开`, "warning");
						stop({ release: false });
						setStatus(STATE_LABEL.locked, `pid ${holder.pid}`);
					}
				}, 30_000);
				state.lockWatch.unref?.();
			}

			// 配置里有明文密钥：权限过宽时提醒一次
			try {
				const mode = fs.statSync(configFile).mode & 0o777;
				if (mode & 0o077) notify(`pi-qq-connect: 配置权限是 0${mode.toString(8)}，建议 chmod 600 ${configFile}`, "warning");
			} catch {
				// ignore
			}

			const auth = new QqAuth({
				appId: config.appId,
				clientSecret: config.clientSecret,
				tokenUrl: config.endpoints.token || undefined,
				log: state.logger,
			});
			const api = new QqApi({ auth, sandbox: config.sandbox, endpoints: config.endpoints, log: state.logger });
			state.runner = createCommandRunner({
				getPi: () => state.extensionApi,
				getCtx: () => state.ctx,
				newSession: (args) => requestNewSession(args),
				notify,
			});
			const bridge = new QqBridge({
				pi: state.extensionApi ?? pi,
				api,
				config,
				log: state.logger,
				notify,
				isOnline: () => state.gateway?.state === "connected",
				onCommand: (command) => handleCommand(command),
			});
			const gateway = new QqGateway({
				auth,
				api,
				log: state.logger,
				onEvent: (type, data) => {
					const item = normalizeEvent(type, data);
					if (!item) return;
					state.lastInbound = { at: new Date().toISOString(), kind: item.kind, chat: maskId(item.chatId), user: maskId(item.userId) };
					const result = bridge.enqueue(item);
					if (!result.accepted) state.logger.debug(`消息未入队：${result.reason}`);
				},
				onState: (s) => {
					setStatus(STATE_LABEL[s] ?? s);
					if (s === "connected") state.error = null;
				},
			});

			state.bridge = bridge;
			state.gateway = gateway;

			setStatus(STATE_LABEL.connecting);
			state.logger.info(`启动网关：${config.sandbox ? "沙箱" : "正式"}环境，AppID ${maskAppId(config.appId)}`);
			void gateway.start().catch((err) => {
				state.error = err?.message ?? String(err);
				state.logger.error(`网关启动失败：${state.error}`);
				setStatus(STATE_LABEL.error, state.error);
			});
		} finally {
			state.starting = false;
			const pending = state.startPending;
			state.startPending = undefined;
			if (pending) {
				if (state.bridge) {
					// 桥已经建好：只需要把新会话的 ctx 接过来，重启一遍会白断网关、丢队列
					state.ctx = pending;
					state.bridge.adopt(state.extensionApi ?? pi);
					void state.bridge.pump();
				} else {
					void start(pending);
				}
			}
		}
	}

	function statusReport() {
		const cfg = state.config;
		const lines = [];
		const lock = readLock(lockFilePath());
		lines.push(`配置：${configPath()}${cfg ? "" : "（未加载）"}`);
		if (state.error) lines.push(`错误：${state.error}`);
		if (!cfg) return lines.join("\n");
		lines.push(`环境：${cfg.sandbox ? "沙箱" : "正式"} · AppID ${maskAppId(cfg.appId)}`);
		lines.push(
			`权限：allowAll=${cfg.allowAll} · 群 ${cfg.allowGroups.length} 个 · 用户 ${cfg.allowUsers.length} 个`,
		);
		const gw = state.gateway;
		lines.push(
			`网关：${
				gw
					? `${STATE_LABEL[gw.state] ?? gw.state} · session ${gw.sessionId ? maskId(gw.sessionId) : "无"}${
							gw.lastCloseCode ? ` · 上次关闭码 ${gw.lastCloseCode}` : ""
						}`
					: "未启动"
			}`,
		);
		const svc = readServiceState(serviceStatePath(baseDir()));
		lines.push(`后台服务：${describeService(svc)}`);
		lines.push(`锁：${lock ? `pid ${lock.pid}（${lock.at}）` : "无"}`);
		if (state.bridge) {
			const s = state.bridge.status;
			const flags = [s.busy ? "Pi 忙" : "", s.stale ? "已暂停，等新会话接棒" : ""].filter(Boolean).join(" · ");
			lines.push(
				`队列：${s.queue} 条${flags ? ` · ${flags}` : ""} · 已收 ${s.stats.received} / 已发 ${s.stats.sent} / 失败 ${s.stats.failed} / 忽略 ${s.stats.ignored}`,
			);
		}
		if (state.lastInbound) {
			lines.push(`最近入站：${state.lastInbound.at} · ${state.lastInbound.kind} · 群/人 ${state.lastInbound.chat}`);
		}
		try {
			const sessionId = state.ctx?.sessionManager?.getSessionId?.();
			const name = state.extensionApi?.getSessionName?.();
			if (sessionId) lines.push(`Pi 会话：${sessionId}${name ? ` · ${name}` : ""}`);
			const model = state.ctx?.model ?? state.extensionApi?.model;
			if (model) {
				const provider = model.provider ?? "?";
				const id = model.id ?? model.modelId ?? "?";
				const thinking = state.extensionApi?.getThinkingLevel?.() ?? "unknown";
				lines.push(`模型：${provider}/${id} · 思考 ${thinking}`);
			}
			const usage = state.ctx?.getContextUsage?.();
			if (usage) {
				const tokens = usage.tokens ?? usage.usedTokens;
				const window = usage.contextWindow ?? usage.maxTokens;
				const percent = Number.isFinite(usage.percent) ? `（${Math.round(usage.percent)}%）` : "";
				lines.push(`上下文：${tokens ?? "?"} / ${window ?? "?"}${percent}`);
			}
			const tools = state.extensionApi?.getActiveTools?.() ?? [];
			if (tools.length) lines.push(`工具：${tools.length} 个`);
		} catch {
			// ignore
		}
		lines.push(`扩展加载：${JSON.stringify(state.config?.extensions ?? "auto")}`);
		return lines.join("\n");
	}

	const HELP = [
		"用法：/qq <命令>",
		"  status      查看网关、队列、最近入站、后台服务",
		"  start       启动后台常驻 pi（QQ 会话交给它）",
		"  stop        停止后台服务；没有服务时断开本进程网关",
		"  （开新会话直接用 /new；/qq new 仍可用，是同一条路径）",
		"  log [n]     看最近 n 条日志（默认 20）",
		"  take        仅锁冲突时：强制接管网关锁（对方 30 秒内自停）",
	].join("\n");

	/** 启动后台常驻服务。 */
	async function startBackground() {
		const file = serviceStatePath(baseDir());
		const svc = readServiceState(file);
		if (svc && isServiceAlive(svc)) {
			// 极端情况下本地还连着网关（例如服务是外部启动的）：先让出，确保只有一条连接
			stop();
			setStatus("服务在线", `pid ${svc.pid}`);
			notify(`后台服务已在运行：${describeService(svc)}`, "info");
			return;
		}
		if (svc) {
			if (!isProcessAlive(svc.pid)) {
				removeServiceState(file, svc.pid);
				notify(`已清理残留状态（pid ${svc.pid} 已退出）`, "info");
			} else {
				notify(
					`pid ${svc.pid} 还活着但心跳已停，可能是别的进程复用了该 pid。确认后运行 /qq stop --force`,
					"warning",
				);
				return;
			}
		}
		// 锁被另一个活进程占着时，服务拉起来也连不上，直接拒绝比"假在线"好
		const holder = readLock(lockFilePath());
		if (holder && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
			notify(
				`网关锁被 pid ${holder.pid} 持有：先关掉那个进程，或 /qq take 强制接管，再 /qq start`,
				"warning",
			);
			return;
		}
		// 本进程先让出网关和锁，交给服务
		stop();
		const { pid, logFile: startedLog, error } = startService({
			binPath: SERVICE_BIN,
			baseDir: baseDir(),
			cwd: state.ctx?.cwd ?? process.cwd(),
			sessionId: "pi-qq-connect-service",
		});
		if (error || !pid) {
			notify(
				`后台服务启动失败：${error ?? "没有拿到 pid"}\n本进程的网关已让出，可用 /qq start 重试\n日志：${startedLog}`,
				"warning",
			);
			return;
		}
		let current = readServiceState(file);
		for (let i = 0; i < 40 && !(current && isServiceAlive(current)); i++) {
			await sleep(200);
			current = readServiceState(file);
		}
		if (current && isServiceAlive(current)) {
			notify(
				`后台服务已启动：${describeService(current)}\nQQ 会话切换到 pi-qq-connect-service（上下文从空开始）\n日志：${startedLog}`,
				"info",
			);
			setStatus("服务在线", `pid ${current.pid}`);
		} else {
			notify(`后台服务启动中（pid ${pid}），稍后用 /qq status 查看。日志：${startedLog}`, "warning");
			setStatus("服务启动中", `pid ${pid}`);
		}
	}

	/** 停止后台服务；没有服务时断开本进程网关。 */
	async function stopBackground(force = false) {
		const file = serviceStatePath(baseDir());
		const svc = readServiceState(file);
		if (svc) {
			if (!isProcessAlive(svc.pid)) {
				removeServiceState(file, svc.pid);
			} else {
				const result = await stopService(svc, { force });
				if (!result.stopped) {
					notify(`停止失败：${result.reason}`, "warning");
					return;
				}
				removeServiceState(file, svc.pid);
				notify("后台服务已停止", "info");
				setStatus(STATE_LABEL.stopped);
				return;
			}
		}
		stop();
		notify("已断开本进程的网关", "info");
		setStatus(STATE_LABEL.stopped);
	}

	// 命令不能在同会话的两个实例里各注册一次：pi 对同名命令的处理是「谁都别执行」。
	let commandsRegistered = false;
	function registerCommands() {
		if (commandsRegistered) return;
		commandsRegistered = true;
		pi.registerCommand("qq", {
			description: "QQ 机器人：status / start / stop / log / take（/new 请直接用 /new）",
		handler: async (args, ctx) => {
			state.ctx = ctx;
			const [sub, ...rest] = String(args ?? "").trim().split(/\s+/);
			switch (sub || "status") {
				case "status":
					notify(statusReport(), "info");
					return;
				case "start":
					await startBackground();
					return;
				case "stop":
					await stopBackground(rest.includes("--force"));
					return;
				case "new": {
					// 0.4.0 起 /new 是唯一入口，这里保留成别名，行为完全一样
					const svc = readServiceState(serviceStatePath(baseDir()));
					if (svc && isServiceAlive(svc) && !isServiceProcess(svc)) {
						notify("后台服务在线：QQ 会话由服务管理，请在 QQ 里发 /new；终端 /new 只切本地 TUI", "warning");
						return;
					}
					notify("正在开新会话…", "info");
					const result = await switchSession(ctx, rest.join(" "));
					if (!result.ok) notify(`开新会话失败：${result.message ?? "未知原因"}`, "warning");
					return;
				}
				case "__new": {
					// QQ 侧 /new 的内部通道：结果直接 resolve 给发起者，不再靠轮询猜
					const pending = state.pendingExec;
					if (!pending) {
						notify("没有等待中的开新会话请求", "warning");
						return;
					}
					notify("正在开新会话…", "info");
					const result = await switchSession(ctx, rest.join(" "));
					pending.done(result);
					return;
				}
				case "log": {
					const n = Number(rest[0]) > 0 ? Math.min(Number(rest[0]), 200) : 20;
					const tail = state.logger?.tail(n) ?? ["（没有日志）"];
					notify(tail.join("\n"), "info");
					return;
				}
				case "take": {
					// 恢复命令：锁被另一个活进程占用时强制接管并本地连网关
					const svc = readServiceState(serviceStatePath(baseDir()));
					if (svc && isServiceAlive(svc)) {
						notify(`后台服务在线（${describeService(svc)}），不需要 /qq take`, "info");
						return;
					}
					const lock = acquireLock(lockFilePath(), { force: true });
					if (!lock.ok) {
						notify("接管失败", "warning");
						return;
					}
					await start(ctx, { keepLock: true });
					if (state.gateway) notify("已接管网关锁并启动本地网关", "info");
					else notify(`已接管锁，但没能连接：${state.error ?? "查看 /qq log"}`, "warning");
					return;
				}
				default:
					notify(HELP, "info");
			}
		},
		});
	}

	pi.on("session_start", (event, ctx) => {
		// 新会话 → 新 ctx：重新选举负责人（同一会话的重复加载共用同一个 ctx）
		if (state.sessionCtx !== ctx) {
			state.sessionCtx = ctx;
			state.owner = pi;
		} else if (state.owner && state.owner !== pi) {
			return;
		}
		state.owner = pi;
		state.ctx = ctx;
		state.extensionApi = pi;
		const reason = event?.reason ?? "startup";
		// 每个会话只由选中的实例注册一次命令（同名重复注册会让命令彻底失效）
		registerCommands();

		if (!state.bridge) {
			// 没有活动桥（首次启动，或上一个实例的桥已经停了）：直接重建
			if (reason !== "startup") {
				notify(`会话已切换（${reason}），当前没有活动桥，正在重建 QQ 连接…`, "warning");
			}
			void start(ctx);
			return;
		}

		// 新会话实例接棒：换成新句柄，别再用旧实例那个已作废的 pi
		state.bridge.adopt(pi);

		// 换会话（含 reload、resume、fork）都保留网关、锁和排队消息，只把暂存条目放回来；
		// 没经历 beginSwitch 的 session_start 不能调 endSwitch，否则会重置一个健康会话的在途轮次
		if (state.bridge.switching) {
			state.bridge.endSwitch();
		} else {
			void state.bridge.pump();
		}
	});

	pi.on("session_shutdown", (event) => {
		const reason = event?.reason ?? "unknown";
		// owner 为 undefined（例如上一个实例刚退出、新的 session_start 还没来）时允许处理，
		// 否则退出时没人收摊、换会话时也没人暂停注入
		if (state.owner && state.owner !== pi) return;
		state.logger?.info(`session_shutdown(${reason})`);
		// 只有明确的退出类 reason 才收摊；其余（含 pi 以后新增的换会话 reason）一律按
		// 「旧句柄即将作废」处理：暂停注入、暂存消息，等新实例的 session_start 接棒。
		if (reason === "quit" || reason === "exit" || reason === "shutdown") {
			state.owner = undefined;
			stop();
			return;
		}
		if (reason !== "new" && reason !== "resume" && reason !== "fork" && reason !== "reload") {
			state.logger?.warn(`未知的 session_shutdown reason=${reason}，按换会话处理（保留网关）`);
		}
		// 这次是真换了会话：请求侧超时/取消时不要再 cancelSwitch（交给看门狗与接棒）
		if (state.pendingExec) state.pendingExec.sawShutdown = true;
		state.bridge?.beginSwitch();
	});

	pi.on("before_agent_start", (event) => {
		if (state.owner !== pi) return;
		state.bridge?.onBeforeAgentStart(event);
	});

	pi.on("agent_start", () => {
		if (state.owner !== pi) return;
		state.bridge?.onAgentStart();
	});

	pi.on("message_end", (event) => {
		if (state.owner !== pi) return;
		state.bridge?.onMessageEnd(event.message);
	});

	pi.on("agent_settled", (event) => {
		if (state.owner !== pi) return;
		state.bridge?.onAgentSettled(Boolean(event.aborted));
	});

	return state;
}

// 方便测试
export { lockFilePath };
