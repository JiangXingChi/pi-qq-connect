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
	startManagedService,
	stopService,
} from "./service.js";
import { Logger } from "./log.js";
import { QqAuth } from "./auth.js";
import { QqApi } from "./api.js";
import { QqGateway } from "./gateway.js";
import { QqBridge, isStaleContextError } from "./session.js";
import { acquireLock, readLock, releaseLock } from "./lock.js";
import { maskAppId, maskId, normalizeEvent } from "./text.js";
import { HELP_TEXT, createCommandRunner } from "./commands.js";
import { CODE, err } from "./i18n.js";

const SERVICE_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-qq-connect.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseDir() {
	return path.dirname(configPath());
}

/**
 * 开新会话失败时该不该立刻取消切换。
 * 只有「确实没开始换会话」才取消；已经收到 session_shutdown 的，交给端侧接棒与看门狗。
 */
export function shouldCancelSwitch({ ok, owner, sawShutdown }) {
	return !ok && owner && !sawShutdown;
}

function lockFilePath() {
	return path.join(baseDir(), "pi-qq-connect.lock");
}

const STATE_LABEL = {
	idle: "not started",
	connecting: "connecting",
	connected: "online",
	disconnected: "reconnecting",
	error: "error",
	stopped: "stopped",
	disabled: "disabled",
	unconfigured: "unconfigured",
	locked: "locked",
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
		ownerStale: false,
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
	// 换会话后旧负责人的句柄已死：新工厂一跑就先把事件接管过来，
	// 万一 pi 没给 session_start，也不至于所有回答都被守卫丢掉
	if (state.ownerStale) state.owner = pi;
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

	function notify(message, level = "info", { silent = false } = {}) {
		state.logger?.[level === "warning" ? "warn" : level === "error" ? "error" : "info"](message);
		// startup / background status notices stay in the log only
		if (silent) return;
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
			state.pendingExec.done({ ok: false, message: "background service stopped" });
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
				notify(err(CODE.NEW_SESSION_FAILED, "new session cancelled"), "warning");
				return { ok: false, cancelled: true, message: "cancelled" };
			}
			return { ok: true };
		} catch (err) {
			if (isStaleContextError(err)) {
				// 旧句柄已失效：新会话其实已经开成，出问题的是桥
				return { ok: false, message: "this session was replaced by another switch; the QQ bridge takes over in the new session" };
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
			return Promise.resolve({ ok: false, message: "a new session is already in progress; wait a moment" });
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
				if (shouldCancelSwitch({ ok: Boolean(result?.ok), owner, sawShutdown: pending?.sawShutdown })) {
					state.bridge?.cancelSwitch();
				}
				resolve(result);
			};
			// 略长于 session.js 的 30 秒切换看门狗：看门狗先恢复队列，这里再清掉 pendingExec；
			// 31~35 秒之间发 /new 仍会被「上一个还在进行中」挡住，可接受
			const timer = setTimeout(() => done({ ok: false, message: "pi did not finish switching sessions within 35s (it may be busy)" }), 35_000);
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

	const BUILTIN_COMMANDS = new Set([
		"settings",
		"model",
		"tree",
		"thinking",
		"scoped-models",
		"export",
		"import",
		"share",
		"bug",
		"copy",
		"name",
		"session",
		"changelog",
		"hotkeys",
		"fork",
		"clone",
		"trust",
		"login",
		"logout",
		"new",
		"compact",
		"resume",
		"reload",
		"quit",
		"help",
		"tools",
	]);

	function isExtensionCommand(name) {
		try {
			return (state.extensionApi?.getCommands?.() ?? []).some((item) => String(item.name).toLowerCase() === name);
		} catch {
			return false;
		}
	}

	/** QQ 里发来的斜杠命令：只映射 /new，其余存在但不可在聊天用的提示回终端。 */
	async function handleCommand(command) {
		const local = await state.runner?.run(command);
		if (local !== null && local !== undefined) return { text: local };
		const name = command.name;
		// 控制类命令只在终端用；`/new` 已由 runner 处理
		if (name === "qq" || name === "wx" || BUILTIN_COMMANDS.has(name)) {
			return { text: err(CODE.TUI_ONLY, `/${name} runs in the terminal; only /new works here`) };
		}
		// 技能、提示模板、其它扩展命令：原样交给 Pi 展开
		if (isExtensionCommand(name)) return { forward: true };
		// 其余 `/...`（如 `/tmp 为什么…`）当普通消息，保留附件与引用
		return { forward: true, asText: true };
	}

	/** /qq 在 QQ 里只回放能纯文本回答的子命令，改机器状态的仍留给终端。 */
	function handleQqSubcommand(args) {
		const [sub, ...rest] = String(args ?? "").trim().split(/\s+/);
		switch (sub || "status") {
			case "status":
				return statusReport();
			case "log": {
				const n = Number(rest[0]) > 0 ? Math.min(Number(rest[0]), 200) : 20;
				return state.logger?.tail(n)?.join("\n") ?? "(no log)";
			}
			case "help":
				return HELP_TEXT;
			case "new":
				return "/qq new is merged into /new; just send /new";
			default:
				return `/qq ${sub} runs in the terminal (it switches the local service). Available in QQ: /qq status, /qq log [n]`;
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
				notify(err(CODE.NO_CONFIG, "config error", `${error}; see examples/config.json`), "warning");
				return;
			}
			for (const warning of warnings) notify(warning, "info", { silent: true });

			if (!config.enabled) {
				setStatus(STATE_LABEL.disabled);
				notify("config has enabled=false; not connected", "info", { silent: true });
				return;
			}

			// 后台常驻服务在线时，本进程只当控制面，不抢网关
			const serviceFile = serviceStatePath(baseDir());
			const service = readServiceState(serviceFile);
			const serviceAlive = Boolean(service && isServiceAlive(service));
			const iAmService = isServiceProcess(service);
			if (serviceAlive && !iAmService) {
				setStatus("service online", `pid ${service.pid}`);
				notify(`background service online (pid ${service.pid}); this process does not connect the gateway; see /qq status`, "info", { silent: true });
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
					state.error = `gateway held by another Pi process (pid ${lock.holder?.pid})`;
					setStatus(STATE_LABEL.locked, `pid ${lock.holder?.pid}`);
					notify(err(CODE.LOCK_HELD, "gateway held by another Pi process", `pid ${lock.holder?.pid}; close that Pi process and retry`), "warning");
					return;
				}
				if (lock.takenOver) notify("took over the gateway lock", "info", { silent: true });
				// 别的进程 /qq take 后，这里要让出网关，否则两个进程各收一半消息
				state.lockWatch = setInterval(() => {
					const holder = readLock(lockFilePath());
					if (holder && holder.pid !== process.pid) {
						notify(err(CODE.LOCK_TAKEN, "gateway taken over by another process", `pid ${holder.pid}; disconnecting`), "warning");
						stop({ release: false });
						setStatus(STATE_LABEL.locked, `pid ${holder.pid}`);
					}
				}, 30_000);
				state.lockWatch.unref?.();
			}

			// 配置里有明文密钥：权限过宽时提醒一次
			try {
				const mode = fs.statSync(configFile).mode & 0o777;
				if (mode & 0o077) notify(err(CODE.CONFIG_PERM, "config file is too permissive", `0${mode.toString(8)}; chmod 600 ${configFile}`), "warning");
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
		lines.push(`config: ${configPath()}${cfg ? "" : " (not loaded)"}`);
		if (state.error) lines.push(`error: ${state.error}`);
		if (!cfg) return lines.join("\n");
		lines.push(`env: ${cfg.sandbox ? "sandbox" : "production"} · appid ${maskAppId(cfg.appId)}`);
		lines.push(
			`acl: allowAll=${cfg.allowAll} · groups ${cfg.allowGroups.length} · users ${cfg.allowUsers.length}`,
		);
		const gw = state.gateway;
		lines.push(
			`gateway: ${
				gw
					? `${STATE_LABEL[gw.state] ?? gw.state} · session ${gw.sessionId ? maskId(gw.sessionId) : "none"}${
							gw.lastCloseCode ? ` · last close code ${gw.lastCloseCode}` : ""
						}`
					: "not running"
			}`,
		);
		const svc = readServiceState(serviceStatePath(baseDir()));
		lines.push(`service: ${describeService(svc)}`);
		lines.push(`lock: ${lock ? `pid ${lock.pid} (${lock.at})` : "none"}`);
		if (state.bridge) {
			const s = state.bridge.status;
			const flags = [
				s.busy ? "pi busy" : "",
				s.switching ? "switching" : "",
				s.stale ? "paused, waiting for the new session" : "",
			]
				.filter(Boolean)
				.join(" · ");
			const deferred = s.deferred ? ` · deferred ${s.deferred}` : "";
			lines.push(
				`queue: ${s.queue}${deferred}${flags ? ` · ${flags}` : ""} · received ${s.stats.received} / sent ${s.stats.sent} / failed ${s.stats.failed} / ignored ${s.stats.ignored}`,
			);
		}
		if (state.lastInbound) {
			lines.push(`last inbound: ${state.lastInbound.at} · ${state.lastInbound.kind} · chat ${state.lastInbound.chat}`);
		}
		if (cfg.maxChunks) {
			lines.push(`budget: up to ${cfg.maxChunks} chunks × ${cfg.chunkChars} chars per message`);
		}
		try {
			const sessionId = state.ctx?.sessionManager?.getSessionId?.();
			const name = state.extensionApi?.getSessionName?.();
			if (sessionId) lines.push(`pi session: ${sessionId}${name ? ` · ${name}` : ""}`);
			const model = state.ctx?.model ?? state.extensionApi?.model;
			if (model) {
				const provider = model.provider ?? "?";
				const id = model.id ?? model.modelId ?? "?";
				lines.push(`model: ${provider}/${id}`);
			}
			lines.push(`thinking: ${state.extensionApi?.getThinkingLevel?.() ?? "unknown"}`);
			const usage = state.ctx?.getContextUsage?.();
			if (usage) {
				const tokens = usage.tokens ?? usage.usedTokens;
				const window = usage.contextWindow ?? usage.maxTokens;
				const percent = Number.isFinite(usage.percent) ? ` (${Math.round(usage.percent)}%)` : "";
				lines.push(`context: ${tokens ?? "?"} / ${window ?? "?"}${percent}`);
			}
			const tools = state.extensionApi?.getActiveTools?.() ?? [];
			if (tools.length) lines.push(`tools: ${tools.length}`);
		} catch {
			// ignore
		}
		return lines.join("\n");
	}

	const HELP = [
		"usage: /qq <command>",
		"  status          service, connection, queue, budget",
		"  start           start the background service",
		"  stop [--force]  stop the service; disconnects this process when none runs",
		"  log [n]         show the last n log lines (default 20)",
		"  help            this list",
		"  login           verify credentials and restart the service",
		"  logout          remove clientSecret (backup kept) and disconnect",
	].join("\n");

	/** 启动后台常驻服务。 */
	async function startBackground() {
		const file = serviceStatePath(baseDir());
		const svc = readServiceState(file);
		if (svc && isServiceAlive(svc)) {
			// 极端情况下本地还连着网关（例如服务是外部启动的）：先让出，确保只有一条连接
			stop();
			setStatus("service online", `pid ${svc.pid}`);
			notify(`background service already running: ${describeService(svc)}`, "info");
			return;
		}
		if (svc) {
			if (!isProcessAlive(svc.pid)) {
				removeServiceState(file, svc.pid);
				notify(`cleaned stale service state (pid ${svc.pid} exited)`, "info");
			} else {
				notify(
					err(CODE.SERVICE_STALE, "service pid is alive but its heartbeat stopped; another process may have reused the pid", `pid ${svc.pid}; run /qq stop --force`),
					"warning",
				);
				return;
			}
		}
		// 锁被另一个活进程占着时，服务拉起来也连不上，直接拒绝比"假在线"好
		const holder = readLock(lockFilePath());
		if (holder && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
			notify(
				err(CODE.LOCK_HELD, "gateway lock is held; close that Pi process, then /qq start", `pid ${holder.pid}`),
				"warning",
			);
			return;
		}
		// 本进程先让出网关和锁，交给服务
		stop();
		const { pid, logFile: startedLog, logHint, error } = await startManagedService({
			binPath: SERVICE_BIN,
			baseDir: baseDir(),
			cwd: state.ctx?.cwd ?? process.cwd(),
			sessionId: "pi-qq-connect-service",
		});
		if (error || !pid) {
			notify(
				err(CODE.SERVICE_START_FAILED, "could not start background service; gateway released, retry /qq start", `${error ?? "no pid"} (log: ${logHint ?? startedLog})`),
				"warning",
			);
			return;
		}
		const current = readServiceState(file);
		if (current && isServiceAlive(current)) {
			notify(
				`background service started: ${describeService(current)}\nQQ session moved to pi-qq-connect-service (fresh context)\nlog: ${logHint ?? startedLog}`,
				"info",
			);
			setStatus("service online", `pid ${current.pid}`);
		} else {
			notify(`background service starting (pid ${pid}); check /qq status later; log: ${logHint ?? startedLog}`, "info");
			setStatus("service starting", `pid ${pid}`);
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
					notify(err(CODE.STOP_FAILED, "stop failed", result.reason), "warning");
					return;
				}
				removeServiceState(file, svc.pid);
				notify("background service stopped", "info");
				setStatus(STATE_LABEL.stopped);
				return;
			}
		}
		stop();
		notify("disconnected this process from the gateway", "info");
		setStatus(STATE_LABEL.stopped);
	}

	// 命令不能在同会话的两个实例里各注册一次：pi 对同名命令的处理是「谁都别执行」。
	let commandsRegistered = false;
	function registerCommands() {
		if (commandsRegistered) return;
		commandsRegistered = true;
		pi.registerCommand("qq", {
			description: "QQ bot: status / start / stop / log / login / logout (use /new for a new session)",
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
				case "__new": {
					// QQ 侧 /new 的内部通道：结果直接 resolve 给发起者，不再靠轮询猜
					const pending = state.pendingExec;
					if (!pending) {
						notify(err(CODE.NEW_SESSION_FAILED, "no pending new-session request"), "warning");
						return;
					}
					notify("opening a new session...", "info");
					const result = await switchSession(ctx, rest.join(" "));
					pending.done(result);
					return;
				}
				case "login": {
					const { config, error } = loadConfig();
					if (error) {
						notify(err(CODE.LOGIN_FAILED, "config error", error), "warning");
						return;
					}
					const auth = new QqAuth({
						appId: config.appId,
						clientSecret: config.clientSecret,
						tokenUrl: config.endpoints.token || undefined,
						log: state.logger,
					});
					try {
						await auth.getToken();
					} catch (cause) {
						notify(err(CODE.LOGIN_FAILED, "QQ auth failed", cause?.message ?? cause), "warning");
						return;
					}
					notify("QQ credentials verified; restarting background service...", "info");
					const svc = readServiceState(serviceStatePath(baseDir()));
					if (svc && isProcessAlive(svc.pid)) {
						const stopped = await stopService(svc, { force: true });
						if (!stopped.stopped) {
							notify(err(CODE.STOP_FAILED, "cannot stop background service; login cancelled", stopped.reason), "warning");
							return;
						}
						removeServiceState(serviceStatePath(baseDir()), svc.pid);
					}
					stop({ release: true });
					await startBackground();
					return;
				}
				case "logout": {
					const svc = readServiceState(serviceStatePath(baseDir()));
					if (svc && isProcessAlive(svc.pid)) {
						const stopped = await stopService(svc, { force: true });
						if (!stopped.stopped) {
							notify(err(CODE.LOGOUT_BLOCKED, "cannot stop background service; logout cancelled", stopped.reason), "warning");
							return;
						}
						removeServiceState(serviceStatePath(baseDir()), svc.pid);
					}
					stop({ release: true });
					const file = configPath();
					try {
						const raw = JSON.parse(fs.readFileSync(file, "utf8"));
						if (!raw.clientSecret) {
							notify("no clientSecret to remove", "info");
							setStatus(STATE_LABEL.unconfigured);
							return;
						}
						const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
						fs.copyFileSync(file, backup);
						delete raw.clientSecret;
						const tmp = `${file}.${process.pid}.tmp`;
						fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
						fs.renameSync(tmp, file);
						notify(`QQ clientSecret removed (backup: ${backup}); refill it and run /qq login`, "info");
						setStatus(STATE_LABEL.unconfigured);
					} catch (cause) {
						notify(err(CODE.LOGOUT_BLOCKED, "could not update config", cause?.message ?? cause), "warning");
					}
					return;
				}
				case "log": {
					const n = Number(rest[0]) > 0 ? Math.min(Number(rest[0]), 200) : 20;
					const tail = state.logger?.tail(n) ?? ["(no log)"];
					notify(tail.join("\n"), "info");
					return;
				}
				default:
					notify(HELP, "info");
			}
		},
		});
	}

	pi.on("session_start", (event, ctx) => {
		// 换会话后旧负责人已经作废：无论 ctx 对象是否相同，都要重新选举
		// （同一个会话里的重复加载不经过 session_shutdown，仍按 ctx 身份去重）
		if (state.ownerStale || state.sessionCtx !== ctx) {
			state.ownerStale = false;
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
				notify(`session switched (${reason}); rebuilding QQ connection...`, "info", { silent: true });
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
			state.ownerStale = false;
			stop();
			return;
		}
		if (reason !== "new" && reason !== "resume" && reason !== "fork" && reason !== "reload") {
			state.logger?.warn(`未知的 session_shutdown reason=${reason}，按换会话处理（保留网关）`);
		}
		// 旧负责人句柄马上作废：下一次 session_start 必须无条件重新选举
		state.ownerStale = true;
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
export { maskAppId } from "./text.js";
