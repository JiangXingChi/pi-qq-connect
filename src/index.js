/**
 * pi-qqbot：把 QQ 官方机器人接到当前 Pi 会话。
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
import { QqBridge } from "./session.js";
import { acquireLock, readLock, releaseLock } from "./lock.js";
import { maskId, normalizeEvent } from "./text.js";

const SERVICE_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-qqbot.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseDir() {
	return path.dirname(configPath());
}

function lockFilePath() {
	return path.join(baseDir(), "pi-qqbot.lock");
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

const RUNTIME_KEY = Symbol.for("pi-qqbot.runtime.v1");
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
		lastInbound: undefined,
		lockWatch: undefined,
		newSessionTimer: undefined,
	};
}

// Pi 在 /new、/resume、/fork 时会重新执行扩展工厂；状态放进程级单例，
// 否则第二次会再连一条网关、抢一次锁。
const shared = root[RUNTIME_KEY] ?? (root[RUNTIME_KEY] = newRuntime());

/** 测试用：彻底清掉进程内状态。 */
export function resetRuntimeForTests() {
	shared.bridge?.stop();
	shared.gateway?.stop();
	if (shared.lockWatch) clearInterval(shared.lockWatch);
	if (shared.newSessionTimer) clearTimeout(shared.newSessionTimer);
	Object.assign(shared, newRuntime());
}

export default function createExtension(pi) {
	const state = shared;
	state.extensionApi = pi;
	if (state.bridge) state.bridge.pi = pi;

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
	 * 当前进程是不是状态文件里那个后台服务（bin 会注入 QQBOT_SERVICE_PID）。
	 * 同时检查 ppid：这个环境变量会被服务里的工具子进程继承，只看 pid 会把孙进程也当成服务。
	 */
	function isServiceProcess(service) {
		return Boolean(
			process.env.QQBOT_SERVICE_PID &&
				service &&
				String(service.pid) === process.env.QQBOT_SERVICE_PID &&
				process.ppid === service.pid,
		);
	}

	function stop({ release = true } = {}) {
		if (state.lockWatch) {
			clearInterval(state.lockWatch);
			state.lockWatch = undefined;
		}
		if (state.newSessionTimer) {
			clearTimeout(state.newSessionTimer);
			state.newSessionTimer = undefined;
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

	/** 终端里 /qq new 直接切；失败只提示，不打断当前会话。 */
	async function switchSession(ctx, name = "") {
		const label = String(name ?? "").trim();
		try {
			const result = await ctx.newSession({
				setup: async (sessionManager) => {
					if (label) sessionManager.appendSessionInfo(label);
				},
			});
			if (result?.cancelled) notify("开新会话被取消", "warning");
		} catch (err) {
			notify(`开新会话失败：${err?.message ?? err}`, "warning");
		}
	}

	/** 通过 Pi 的扩展命令通道开新会话：sendUserMessage 的 expandPromptTemplates 会执行 /qq new。 */
	function requestNewSession(args = "") {
		const text = args ? `/qq new ${args}` : "/qq new";
		try {
			state.extensionApi.sendUserMessage(text, { expandPromptTemplates: true });
		} catch (err) {
			state.bridge?.notifyNewSessionFailed(err?.message ?? String(err));
			return;
		}
		if (state.newSessionTimer) clearTimeout(state.newSessionTimer);
		state.newSessionTimer = setTimeout(() => {
			state.newSessionTimer = undefined;
			state.bridge?.notifyNewSessionFailed("6 秒内没有切到新会话");
		}, 6000);
		state.newSessionTimer.unref?.();
	}

	async function start(ctx) {
		if (state.starting) return;
		state.starting = true;
		state.ctx = ctx ?? state.ctx;
		try {
			// 自己先让出网关和锁；后面早退（未配置/被服务接管/锁被占）时不会留下悬空锁
			stop();
			state.error = null;
			state.lastInbound = undefined;

			const { config, path: configFile, exists, warnings, error } = loadConfig();
			state.config = config;
			state.logger = new Logger(config.log);

			if (!exists || error) {
				state.error = error;
				setStatus(STATE_LABEL.unconfigured, path.basename(configFile));
				notify(`pi-qqbot: ${error}\n示例配置见项目内 examples/config.json`, "warning");
				return;
			}
			for (const warning of warnings) notify(`pi-qqbot: ${warning}`, "info");

			if (!config.enabled) {
				setStatus(STATE_LABEL.disabled);
				notify("pi-qqbot: 配置里 enabled=false，未连接", "info");
				return;
			}

			// 后台常驻服务在线时，本进程只当控制面，不抢网关
			const serviceFile = serviceStatePath(baseDir());
			const service = readServiceState(serviceFile);
			const serviceAlive = Boolean(service && isServiceAlive(service));
			const iAmService = isServiceProcess(service);
			if (serviceAlive && !iAmService) {
				setStatus("服务在线", `pid ${service.pid}`);
				notify(`pi-qqbot: 后台服务在线（pid ${service.pid}），本进程不连网关。用 /qq status 查看`, "info");
				return;
			}

			if (config.lock) {
				const lock = acquireLock(lockFilePath());
				if (!lock.ok) {
					state.error = `网关已被另一个 Pi 进程持有（pid ${lock.holder?.pid}）`;
					setStatus(STATE_LABEL.locked, `pid ${lock.holder?.pid}`);
					notify(`pi-qqbot: ${state.error}。关掉那个进程，或在终端运行 /qq take 强制接管。`, "warning");
					return;
				}
				if (lock.takenOver) notify("pi-qqbot: 已强制接管网关", "info");
				// 别的进程 /qq take 后，这里要让出网关，否则两个进程各收一半消息
				state.lockWatch = setInterval(() => {
					const holder = readLock(lockFilePath());
					if (holder && holder.pid !== process.pid) {
						notify(`pi-qqbot: 网关已被 pid ${holder.pid} 接管，本进程断开`, "warning");
						stop({ release: false });
						setStatus(STATE_LABEL.locked, `pid ${holder.pid}`);
					}
				}, 30_000);
				state.lockWatch.unref?.();
			}

			// 配置里有明文密钥：权限过宽时提醒一次
			try {
				const mode = fs.statSync(configFile).mode & 0o777;
				if (mode & 0o077) notify(`pi-qqbot: 配置权限是 0${mode.toString(8)}，建议 chmod 600 ${configFile}`, "warning");
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
			const bridge = new QqBridge({
				pi,
				api,
				config,
				log: state.logger,
				notify,
				isOnline: () => state.gateway?.state === "connected",
				onNewSession: (args) => requestNewSession(args),
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
			state.logger.info(`启动网关：${config.sandbox ? "沙箱" : "正式"}环境，AppID ${maskId(config.appId)}`);
			void gateway.start().catch((err) => {
				state.error = err?.message ?? String(err);
				state.logger.error(`网关启动失败：${state.error}`);
				setStatus(STATE_LABEL.error, state.error);
			});
		} finally {
			state.starting = false;
		}
	}

	function statusReport() {
		const cfg = state.config;
		const lines = [];
		const lock = readLock(lockFilePath());
		lines.push(`配置：${configPath()}${cfg ? "" : "（未加载）"}`);
		if (state.error) lines.push(`错误：${state.error}`);
		if (!cfg) return lines.join("\n");
		lines.push(`环境：${cfg.sandbox ? "沙箱" : "正式"} · AppID ${maskId(cfg.appId)}`);
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
			lines.push(`队列：${s.queue} 条${s.busy ? " · Pi 忙" : ""} · 已收 ${s.stats.received} / 已发 ${s.stats.sent} / 失败 ${s.stats.failed} / 忽略 ${s.stats.ignored}`);
		}
		if (state.lastInbound) {
			lines.push(`最近入站：${state.lastInbound.at} · ${state.lastInbound.kind} · 群/人 ${state.lastInbound.chat}`);
		}
		try {
			const sessionId = state.ctx?.sessionManager?.getSessionId?.();
			if (sessionId) lines.push(`Pi 会话：${sessionId}`);
		} catch {
			// ignore
		}
		return lines.join("\n");
	}

	const HELP = [
		"用法：/qq <命令>",
		"  status      查看网关、队列、最近入站、后台服务",
		"  start       启动后台常驻 pi（QQ 会话交给它）",
		"  stop        停止后台服务；没有服务时断开本进程网关",
		"  new [名称]  开一个新的 Pi 会话（QQ 里发 /qq new 也可）",
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
		// 本进程先让出网关和锁，交给服务
		stop();
		const { pid, logFile: startedLog, error } = startService({
			binPath: SERVICE_BIN,
			baseDir: baseDir(),
			cwd: state.ctx?.cwd ?? process.cwd(),
			sessionId: "pi-qqbot-service",
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
				`后台服务已启动：${describeService(current)}\nQQ 会话切换到 pi-qqbot-service（上下文从空开始）\n日志：${startedLog}`,
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

	pi.registerCommand("qq", {
		description: "QQ 机器人：status / start / stop / new / log / take",
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
					const svc = readServiceState(serviceStatePath(baseDir()));
					if (svc && isServiceAlive(svc) && !isServiceProcess(svc)) {
						notify("后台服务在线：QQ 会话由服务管理，请在 QQ 里发 /qq new；终端 /new 只切本地 TUI", "warning");
						return;
					}
					notify("正在开新会话…", "info");
					await switchSession(ctx, rest.join(" "));
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
					await start(ctx);
					if (state.gateway) notify("已接管网关锁并启动本地网关", "info");
					else notify(`已接管锁，但没能连接：${state.error ?? "查看 /qq log"}`, "warning");
					return;
				}
				default:
					notify(HELP, "info");
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
		state.ctx = ctx;
		state.extensionApi = pi;
		if (state.bridge) state.bridge.pi = pi;

		// /new /resume /fork 只是换了 Pi 会话：网关、锁保留
		if (["new", "resume", "fork"].includes(event?.reason)) {
			if (state.newSessionTimer) {
				clearTimeout(state.newSessionTimer);
				state.newSessionTimer = undefined;
			}
			if (event.reason === "new") {
				void state.bridge?.onSessionSwitched();
			} else {
				// 手动 resume/fork：丢掉旧队列与待确认的 /qq new，但不发「已开新会话」
				state.bridge?.clearPendingNew();
				state.bridge?.reset();
			}
			return;
		}
		void start(ctx);
	});

	pi.on("session_shutdown", (event) => {
		// 同一进程换会话时保留网关和锁；只有退出/重载才收摊
		if (event?.reason === "new" || event?.reason === "resume" || event?.reason === "fork") return;
		stop();
	});

	pi.on("before_agent_start", (event) => {
		state.bridge?.onBeforeAgentStart(event);
	});

	pi.on("agent_start", () => {
		state.bridge?.onAgentStart();
	});

	pi.on("message_end", (event) => {
		state.bridge?.onMessageEnd(event.message);
	});

	pi.on("agent_settled", (event) => {
		state.bridge?.onAgentSettled(Boolean(event.aborted));
	});

	return state;
}

// 方便测试
export { lockFilePath };
