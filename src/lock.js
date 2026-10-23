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
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	try {
		// 先写完整内容，再用硬链接原子“抢锁”：文件一出现就是完整 JSON，不存在空窗
		fs.writeFileSync(tmp, payload, { mode: 0o600 });
		try {
			fs.linkSync(tmp, file);
			return { ok: true, takenOver: false };
		} catch (err) {
			if (err?.code !== "EEXIST") return { ok: false, error: "无法写入锁文件" };
			// 必须重读：readLock 与 link 之间可能刚被别人写入
			const current = readLock(file);
			if (current && current.pid !== pid && isProcessAlive(current.pid) && !force) {
				return { ok: false, holder: current };
			}
			// 同一 pid / 死锁 / force：原子替换
			fs.renameSync(tmp, file);
			return { ok: true, takenOver: Boolean(holder && holder.pid !== pid && force) };
		}
	} catch (err) {
		return { ok: false, error: err?.message ?? "无法写入锁文件" };
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// tmp 已被 rename 或本就不存在
		}
	}
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
