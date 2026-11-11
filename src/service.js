/**
 * 后台常驻服务管理：一个独立的 `pi --mode rpc` 进程承载 QQ 会话。
 *
 * - `bin/pi-qq-connect.mjs` 启动后写状态文件并每 15 秒打一次心跳
 * - 插件读状态文件判断服务是否在线；在线时自己不再连网关（避免双开抢消息）
 * - `/qq start|stop` 通过 detached spawn / SIGTERM 管理它
 */

import { execFile, spawn } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import fs from "node:fs";
import path from "node:path";

const HEARTBEAT_STALE_MS = 45_000;

export function serviceStatePath(baseDir) {
	return path.join(baseDir, "pi-qq-connect.service.json");
}

export function serviceLogPath(baseDir) {
	return path.join(baseDir, "pi-qq-connect.service.log");
}

export function hasSystemdUnit() {
	return fs.existsSync(path.join(os.homedir(), ".config", "systemd", "user", "pi-qq-connect.service"));
}

/**
 * 启动后台服务：装了 systemd 单元就交给 systemctl（日志进 journal、开机自启一致），
 * 否则退回 detached spawn。返回时尽量等到心跳上线。
 */
export async function startManagedService({ binPath, baseDir, cwd, sessionId = "pi-qq-connect-service" }, { waitMs = 8000 } = {}) {
	const logFile = serviceLogPath(baseDir);
	let usedSystemd = false;
	if (hasSystemdUnit()) {
		let systemdError = "";
		try {
			await execFileAsync("systemctl", ["--user", "start", "pi-qq-connect.service"], { timeout: 5_000 });
		} catch (cause) {
			systemdError = String(cause?.stderr || cause?.message || "systemctl failed").trim();
		}
		if (!systemdError) {
			usedSystemd = true;
		} else {
			const started = startService({ binPath, baseDir, cwd, sessionId });
			if (!started.pid) {
				return { pid: null, logFile, systemd: false, error: `${systemdError}; fallback start failed: ${started.error ?? "unknown reason"}` };
			}
		}
	} else {
		const started = startService({ binPath, baseDir, cwd, sessionId });
		if (!started.pid) return { ...started, systemd: false };
	}
	const stateFile = serviceStatePath(baseDir);
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const state = readServiceState(stateFile);
		if (state && isServiceAlive(state)) return { pid: state.pid, logFile, systemd: usedSystemd, logHint: usedSystemd ? "journalctl --user -u pi-qq-connect -n 50" : undefined };
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return { pid: null, logFile, systemd: usedSystemd, logHint: usedSystemd ? "journalctl --user -u pi-qq-connect -n 50" : undefined, error: "service did not come online within 8s" };
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
	if (!state) return "not running";
	const alive = isProcessAlive(state.pid);
	const fresh = isServiceAlive(state, { now, staleMs });
	const parsed = Date.parse(state.heartbeatAt ?? "");
	const beat = Number.isFinite(parsed) ? Math.round((now - parsed) / 1000) : null;
	const detail = !alive ? "process exited" : fresh ? "online" : beat === null ? "heartbeat time unknown" : `heartbeat stopped ${beat}s ago`;
	return `pid ${state.pid} · ${detail} · session ${state.sessionId ?? "?"}`;
}

/**
 * 拉起后台服务（detached，父进程退出后仍在）。
 * @returns {{pid:number|null, logFile:string}}
 */
export function startService({ binPath, baseDir, cwd, sessionId = "pi-qq-connect-service", nodePath = process.execPath }) {
	const logFile = serviceLogPath(baseDir);
	if (!fs.existsSync(binPath)) {
		return { pid: null, logFile, error: `start script not found: ${binPath}` };
	}
	if (!fs.existsSync(cwd)) {
		return { pid: null, logFile, error: `working directory does not exist: ${cwd}` };
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
		child.on("error", (err) => {
			try {
				fs.appendFileSync(logFile, `[pi-qq-connect] spawn 失败：${err?.message ?? err}\n`);
			} catch {
				// ignore
			}
		});
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
		return /pi-qq-connect/.test(cmdline);
	} catch {
		return true;
	}
}

export async function stopService(state, { timeoutMs = 10_000, intervalMs = 200, force = false } = {}) {
	if (!state || !isProcessAlive(state.pid)) return { stopped: true, reason: "already-exited" };
	if (!force && !isServiceAlive(state)) {
		return {
			stopped: false,
			reason: `pid ${state.pid} is alive but the heartbeat stopped; another process may have reused the pid; run /qq stop --force after confirming`,
		};
	}
	if (force && !looksLikeService(state.pid)) {
		return { stopped: false, reason: `pid ${state.pid} does not look like pi-qq-connect; refusing to force-kill` };
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
	return { stopped: false, reason: `process ${state.pid} did not exit within ${timeoutMs}ms` };
}


