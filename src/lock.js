/**
 * 单实例锁：同一个 QQ AppID 只能有一个进程持有网关，
 * 否则两个进程各自 identify，消息会被随机分走。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

export function readLock(file) {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		if (data && Number.isInteger(data.pid)) return data;
		return null;
	} catch {
		return null;
	}
}

/**
 * @returns {{ok:boolean, holder?:object, takenOver?:boolean}}
 */
export function acquireLock(file, { force = false, pid = process.pid } = {}) {
	const holder = readLock(file);
	if (holder && holder.pid !== pid && isProcessAlive(holder.pid) && !force) {
		return { ok: false, holder };
	}
	const payload = JSON.stringify({ pid, host: os.hostname(), at: new Date().toISOString() });
	const written = (() => {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const fd = fs.openSync(file, "wx", 0o600);
			try {
				fs.writeFileSync(fd, payload);
			} finally {
				fs.closeSync(fd);
			}
			return true;
		} catch (err) {
			if (err?.code !== "EEXIST") return false;
			// 已存在：同一 pid 或确认可接管时才覆盖
			try {
				fs.writeFileSync(file, payload, { mode: 0o600 });
				return true;
			} catch {
				return false;
			}
		}
	})();
	if (!written) return { ok: false, error: "无法写入锁文件" };
	return { ok: true, takenOver: Boolean(holder && holder.pid !== pid && force) };
}

export function releaseLock(file, pid = process.pid) {
	const holder = readLock(file);
	if (holder && holder.pid !== pid) return;
	try {
		fs.unlinkSync(file);
	} catch {
		// ignore
	}
}
