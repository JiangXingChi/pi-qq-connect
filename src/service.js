/**
 * 后台常驻服务管理：一个独立的 `pi --mode rpc` 进程承载 QQ 会话。
 *
 * - `bin/pi-qqbot.mjs` 启动后写状态文件并每 15 秒打一次心跳
 * - 插件读状态文件判断服务是否在线；在线时自己不再连网关（避免双开抢消息）
 * - `/qq start|stop` 通过 detached spawn / SIGTERM 管理它
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HEARTBEAT_STALE_MS = 45_000;

export function serviceStatePath(baseDir) {
	return path.join(baseDir, "pi-qqbot.service.json");
}

export function serviceLogPath(baseDir) {
	return path.join(baseDir, "pi-qqbot.service.log");
}

export function readServiceState(file) {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!data || typeof data !== "object" || !Number.isInteger(data.pid)) return null;
		return data;
	} catch {
		return null;
	}
}

export function writeServiceState(file, data) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function removeServiceState(file, pid = process.pid) {
	const state = readServiceState(file);
	if (state && state.pid !== pid) return; // 不是自己写的，不动
	try {
		fs.unlinkSync(file);
	} catch {
		// ignore
	}
}

export function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

/** 在线 = 进程活着 + 心跳没超时。 */
export function isServiceAlive(state, { now = Date.now(), staleMs = HEARTBEAT_STALE_MS } = {}) {
	if (!state || !isProcessAlive(state.pid)) return false;
	const at = Date.parse(state.heartbeatAt ?? state.startedAt ?? "");
	if (!Number.isFinite(at)) return false;
	return now - at <= staleMs;
}

export function describeService(state, { now = Date.now(), staleMs = HEARTBEAT_STALE_MS } = {}) {
	if (!state) return "未运行";
	const alive = isProcessAlive(state.pid);
	const fresh = isServiceAlive(state, { now, staleMs });
	const parsed = Date.parse(state.heartbeatAt ?? "");
	const beat = Number.isFinite(parsed) ? Math.round((now - parsed) / 1000) : null;
	const detail = !alive ? "进程已退出" : fresh ? "在线" : beat === null ? "心跳时间未知" : `心跳停了 ${beat}s`;
	return `pid ${state.pid} · ${detail} · 会话 ${state.sessionId ?? "?"}`;
}

/**
 * 拉起后台服务（detached，父进程退出后仍在）。
 * @returns {{pid:number|null, logFile:string}}
 */
export function startService({ binPath, baseDir, cwd, sessionId = "pi-qqbot-service", nodePath = process.execPath }) {
	const logFile = serviceLogPath(baseDir);
	if (!fs.existsSync(binPath)) {
		return { pid: null, logFile, error: `找不到启动脚本：${binPath}` };
	}
	if (!fs.existsSync(cwd)) {
		return { pid: null, logFile, error: `工作目录不存在：${cwd}` };
	}
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	try {
		if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
	} catch {
		// 日志不存在或轮转失败都不影响启动
	}
	let out;
	try {
		out = fs.openSync(logFile, "a");
		const child = spawn(nodePath, [binPath, "--cwd", cwd, "--session-id", sessionId], {
			cwd,
			detached: true,
			stdio: ["ignore", out, out],
			env: { ...process.env },
		});
		// spawn 的失败是异步 error 事件；没有监听器会直接打崩调用方（TUI）
		child.on("error", () => {});
		child.unref();
		return { pid: child.pid ?? null, logFile };
	} catch (err) {
		return { pid: null, logFile, error: err?.message ?? String(err) };
	} finally {
		if (out !== undefined) {
			try {
				fs.closeSync(out);
			} catch {
				// ignore
			}
		}
	}
}

/**
 * SIGTERM 并等它退出；不自动 SIGKILL。
 * 心跳已停但 pid 还活着时（可能是残留 pid 被复用），默认拒绝，需 force。
 */
function looksLikeService(pid) {
	// 非 Linux 或读不到 /proc 时不做判断，保持原行为
	try {
		const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
		return /pi-qqbot/.test(cmdline);
	} catch {
		return true;
	}
}

export async function stopService(state, { timeoutMs = 10_000, intervalMs = 200, force = false } = {}) {
	if (!state || !isProcessAlive(state.pid)) return { stopped: true, reason: "already-exited" };
	if (!force && !isServiceAlive(state)) {
		return {
			stopped: false,
			reason: `pid ${state.pid} 还活着但心跳已停，可能是别的进程复用了该 pid；确认后用 /qq stop --force`,
		};
	}
	if (force && !looksLikeService(state.pid)) {
		return { stopped: false, reason: `pid ${state.pid} 看起来不是 pi-qqbot，拒绝强制结束` };
	}
	try {
		process.kill(state.pid, "SIGTERM");
	} catch (err) {
		return { stopped: false, reason: err?.message ?? String(err) };
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(state.pid)) return { stopped: true };
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return { stopped: false, reason: `进程 ${state.pid} 在 ${timeoutMs}ms 内没有退出` };
}


