/**
 * 出站富媒体：[[file:/abs/path]] 标记解析 + QQ 分片上传。
 *
 * 官方流程（单聊/群聊接口不互通）：
 *   upload_prepare → 逐片 PUT 预签名 URL → upload_part_finish → /files 合并 → file_info
 * 发送时 msg_type=7，media.file_info 透传，仍带 msg_id/msg_seq。
 *
 * 安全：文件由模型显式标记才会发送；这里再拦一层敏感路径和大小。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = /\[\[file:\s*([^\]\n]+?)\s*\]\]/gi;
const HARD_LIMIT = 200 * 1024 * 1024;
const IMAGE_LIMIT = 20 * 1024 * 1024;
const VIDEO_LIMIT = 30 * 1024 * 1024;
const VOICE_LIMIT = 20 * 1024 * 1024;

const DENY = [
	/\/\.ssh\//,
	/\/\.gnupg\//,
	/\/\.aws\//,
	/\/\.hermes\//,
	/\/\.config\//,
	/\/\.pi\/agent\//,
	/\/\.local\/share\/keyrings\//,
	/(^|\/)\.env(\.|$)/i,
	/(^|\/)pi-qqbot\.json$/,
	/(^|\/)id_(rsa|ed25519|ecdsa)$/,
];

function expandHome(p) {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * 从回复里摘出文件标记，返回清理后的正文和去重后的绝对路径。
 * @returns {{text:string, files:string[], skipped:string[]}}
 */
export function parseFileMarkers(text, { maxCount = 3 } = {}) {
	const source = String(text ?? "");
	const files = [];
	const skipped = [];
	let match;
	MARKER.lastIndex = 0;
	while ((match = MARKER.exec(source))) {
		const raw = expandHome(match[1].trim().replace(/^["'`]|["'`]$/g, ""));
		if (!raw) continue;
		if (!path.isAbsolute(raw)) {
			skipped.push(`${raw}（不是绝对路径）`);
			continue;
		}
		const resolved = path.resolve(raw);
		if (files.includes(resolved)) continue;
		if (files.length >= maxCount) {
			skipped.push(`${resolved}（超过 ${maxCount} 个）`);
			continue;
		}
		files.push(resolved);
	}
	const cleaned = source
		.replace(MARKER, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { text: cleaned, files, skipped };
}

/** 校验文件：存在、普通文件、非敏感路径、不超过硬限制。 */
export async function inspectFile(filePath, { maxBytes = HARD_LIMIT, allowDirs = [] } = {}) {
	let real;
	try {
		real = await fs.promises.realpath(filePath);
	} catch {
		return { ok: false, reason: "文件不存在" };
	}
	const normalized = real.split(path.sep).join("/");
	if (DENY.some((re) => re.test(normalized))) return { ok: false, reason: "敏感路径，拒绝发送" };
	if (allowDirs.length > 0) {
		const allowed = allowDirs.map((dir) => path.resolve(expandHome(String(dir))));
		if (!allowed.some((dir) => real === dir || real.startsWith(dir + path.sep))) {
			return { ok: false, reason: "不在允许的目录里" };
		}
	}
	const stat = await fs.promises.stat(real);
	if (!stat.isFile()) return { ok: false, reason: "不是普通文件" };
	if (stat.size <= 0) return { ok: false, reason: "空文件" };
	if (stat.size > Math.min(maxBytes, HARD_LIMIT)) return { ok: false, reason: "超过大小限制" };
	return { ok: true, path: real, size: stat.size, name: path.basename(real) };
}

/** 按扩展名给 file_type；超过软限制的图片/视频/语音降级为文件。 */
export function fileTypeFor(filePath, size) {
	const ext = path.extname(filePath).toLowerCase();
	if ([".png", ".jpg", ".jpeg"].includes(ext)) return size > IMAGE_LIMIT ? 4 : 1;
	if (ext === ".mp4") return size > VIDEO_LIMIT ? 4 : 2;
	if (ext === ".silk") return size > VOICE_LIMIT ? 4 : 3;
	return 4;
}

async function hashFile(filePath, size) {
	const md5 = createHash("md5");
	const sha1 = createHash("sha1");
	const md5Head = createHash("md5");
	const headLimit = 10_002_432;
	let seen = 0;
	await new Promise((resolve, reject) => {
		const stream = fs.createReadStream(filePath);
		stream.on("data", (buf) => {
			md5.update(buf);
			sha1.update(buf);
			if (seen < headLimit) {
				const take = Math.min(buf.length, headLimit - seen);
				md5Head.update(buf.subarray(0, take));
			}
			seen += buf.length;
		});
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	if (seen !== size) throw new Error("文件在读取过程中发生变化");
	return { md5: md5.digest("hex"), sha1: sha1.digest("hex"), md5_10m: md5Head.digest("hex") };
}

async function readSlice(handle, offset, length) {
	const buf = Buffer.alloc(length);
	let read = 0;
	while (read < length) {
		const { bytesRead } = await handle.read(buf, read, length - read, offset + read);
		if (bytesRead === 0) break;
		read += bytesRead;
	}
	return read === length ? buf : buf.subarray(0, read);
}

/**
 * 上传本地文件，返回 { fileInfo, ttl, name, size, fileType }。
 * @param {import("./api.js").QqApi} api
 * @param {{type:"group"|"private", openid:string}} target
 */
export async function uploadFile(api, target, filePath, { log, maxBytes, allowDirs } = {}) {
	const info = await inspectFile(filePath, { maxBytes, allowDirs });
	if (!info.ok) throw new Error(`${path.basename(filePath)}：${info.reason}`);
	const fileType = fileTypeFor(info.path, info.size);
	const hashes = await hashFile(info.path, info.size);
	const prep = await api.uploadPrepare(target, {
		fileType,
		fileSize: info.size,
		fileName: info.name,
		...hashes,
	});
	if (!prep?.upload_id || !Array.isArray(prep.parts) || prep.parts.length === 0) {
		throw new Error("预上传没有返回 upload_id 或分片");
	}
	const handle = await fs.promises.open(info.path, "r");
	try {
		// 线上 parts 的 index 从 1 开始，文档写从 0；不猜序号，按排序后的位置累加 offset。
		const parts = [...prep.parts].sort((a, b) => Number(a.index) - Number(b.index));
		let offset = 0;
		for (const part of parts) {
			const block = Number(part.block_size) || Number(prep.block_size);
			const length = Math.min(block, info.size - offset);
			if (length <= 0) break;
			const buf = await readSlice(handle, offset, length);
			await api.putPresigned(part.presigned_url, buf);
			await api.uploadPartFinish(target, {
				uploadId: prep.upload_id,
				index: Number(part.index),
				blockSize: length,
				md5: createHash("md5").update(buf).digest("hex"),
			});
			offset += length;
		}
		if (offset !== info.size) throw new Error(`分片只上传了 ${offset}/${info.size} 字节`);
	} finally {
		await handle.close();
	}
	const merged = await api.finishUpload(target, { uploadId: prep.upload_id });
	if (!merged?.file_info) throw new Error("合并分片后没有返回 file_info");
	log?.info(`文件已上传：${info.name}（${info.size} 字节，类型 ${fileType}，ttl ${merged.ttl ?? "?"}s）`);
	return { fileInfo: merged.file_info, ttl: Number(merged.ttl ?? 0), name: info.name, size: info.size, fileType };
}
