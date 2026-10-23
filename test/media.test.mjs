import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { QqApi } from "../src/api.js";
import { QqAuth } from "../src/auth.js";
import { normalizeConfig } from "../src/config.js";
import { fileTypeFor, inspectFile, parseFileMarkers, uploadFile } from "../src/media.js";
import { QqBridge } from "../src/session.js";
import { createFakePi, sleep, waitFor } from "./harness.mjs";
import { startMockQq } from "./mock-qq.mjs";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

test("文件标记：解析、去重、跳过相对路径", () => {
	const parsed = parseFileMarkers("图\n[[file:/tmp/a.png]]\n[[file:/tmp/a.png]]\n[[file:~/b.txt]]\n[[file:rel.txt]]", {
		maxCount: 3,
	});
	assert.equal(parsed.files.length, 2);
	assert.ok(parsed.files[0].endsWith("/tmp/a.png"));
	assert.ok(parsed.files[1].endsWith("/b.txt"));
	assert.equal(parsed.skipped.length, 1);
	assert.match(parsed.text, /^图$/);
});

test("文件标记：最多 maxCount 个，多余被忽略", () => {
	const parsed = parseFileMarkers("[[file:/tmp/1]] [[file:/tmp/2]] [[file:/tmp/3]]", { maxCount: 2 });
	assert.equal(parsed.files.length, 2);
	assert.equal(parsed.skipped.length, 1);
});

test("文件校验：拒绝敏感路径与空文件", async () => {
	const dir = await fs.promises.mkdtemp(path.join(process.cwd(), "test", "tmp-media-"));
	const empty = path.join(dir, "empty.txt");
	await fs.promises.writeFile(empty, "");
	const emptyResult = await inspectFile(empty);
	assert.equal(emptyResult.ok, false);
	assert.match(emptyResult.reason, /空文件/);

	const sshDir = path.join(dir, ".ssh");
	await fs.promises.mkdir(sshDir);
	const key = path.join(sshDir, "id_rsa");
	await fs.promises.writeFile(key, "secret");
	const keyResult = await inspectFile(key);
	assert.equal(keyResult.ok, false);

	const okFile = path.join(dir, "note.txt");
	await fs.promises.writeFile(okFile, "hello");
	const okResult = await inspectFile(okFile);
	assert.equal(okResult.ok, true);
	assert.equal(okResult.size, 5);

	const blocked = await inspectFile(okFile, { allowDirs: [path.join(dir, "other")] });
	assert.equal(blocked.ok, false);
	await fs.promises.rm(dir, { recursive: true, force: true });
});

test("文件类型：图片/视频/语音/其他", () => {
	assert.equal(fileTypeFor("/a.png", 1024), 1);
	assert.equal(fileTypeFor("/a.jpg", 21 * 1024 * 1024), 4);
	assert.equal(fileTypeFor("/a.mp4", 1024), 2);
	assert.equal(fileTypeFor("/a.silk", 1024), 3);
	assert.equal(fileTypeFor("/a.zip", 1024), 4);
});

test("上传：预上传 → 分片 PUT → 确认 → 合并 → 富媒体发送", async () => {
	const mock = await startMockQq();
	const auth = new QqAuth({
		appId: "app",
		clientSecret: "secret",
		tokenUrl: `${mock.base}/app/getAppAccessToken`,
	});
	const api = new QqApi({ auth, endpoints: { api: mock.base }, log: silentLog });
	const dir = await fs.promises.mkdtemp(path.join(process.cwd(), "test", "tmp-upload-"));
	const file = path.join(dir, "note.txt");
	await fs.promises.writeFile(file, Buffer.alloc(3000, 7));
	try {
		const uploaded = await uploadFile(api, { type: "private", openid: "user-1" }, file, { log: silentLog });
		assert.equal(uploaded.fileInfo, "file-info-1");
		assert.equal(uploaded.size, 3000);
		assert.equal(uploaded.fileType, 4);

		const prep = mock.state.uploadPrepares[0];
		assert.equal(prep.body.file_type, 4);
		assert.equal(prep.body.file_size, "3000");
		assert.match(prep.body.md5, /^[0-9a-f]{32}$/);
		assert.match(prep.body.sha1, /^[0-9a-f]{40}$/);
		assert.match(prep.body.md5_10m, /^[0-9a-f]{32}$/);

		assert.equal(mock.state.uploadParts.length, 2);
		assert.equal(mock.state.partFinishes.length, 2);
		assert.equal(mock.state.fileMerges[0].upload_id, "upload-1");

		await api.sendMedia({ type: "private", openid: "user-1" }, uploaded.fileInfo, { msgId: "msg-1", msgSeq: 9 });
		const sent = mock.state.messageRequests.find((r) => r.body?.msg_type === 7);
		assert.ok(sent);
		assert.equal(sent.body.media.file_info, "file-info-1");
		assert.equal(sent.body.msg_id, "msg-1");
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true });
		await mock.stop();
	}
});

test("API 错误信息里的 openid 会打码", async () => {
	const mock = await startMockQq();
	const api = new QqApi({
		auth: { getToken: async () => "t", invalidate() {} },
		endpoints: { api: mock.base },
		log: silentLog,
	});
	try {
		mock.state.failNextSend = { status: 400, body: { code: 40054, message: "mock failure" } };
		await assert.rejects(
			() => api.sendText({ type: "private", openid: "448243F5CDC029CBA3FD9BC9C0340D62" }, "x", { msgId: "m", msgSeq: 1 }),
			(err) => {
				assert.ok(!err.message.includes("448243F5CDC029CBA3FD9BC9C0340D62"), "不能泄漏完整 openid");
				assert.match(err.message, /448243…0D62/);
				return true;
			},
		);
	} finally {
		await mock.stop();
	}
});

test("上传：网络/5xx 重试，4xx 不重试", async () => {
	const dir = await fs.promises.mkdtemp(path.join(process.cwd(), "test", "tmp-retry-media-"));
	const file = path.join(dir, "a.bin");
	await fs.promises.writeFile(file, Buffer.alloc(10, 1));
	const counts = { put: 0, part: 0, merge: 0 };
	const stub = (failMergeStatus = 0) => ({
		async uploadPrepare() {
			return { upload_id: "u", block_size: "10", parts: [{ index: 1, presigned_url: "http://x/1", block_size: "10" }] };
		},
		async putPresigned() {
			counts.put++;
			if (counts.put === 1) throw new Error("ECONNRESET");
		},
		async uploadPartFinish() {
			counts.part++;
			if (counts.part === 1) {
				const error = new Error("server error");
				error.status = 500;
				throw error;
			}
		},
		async finishUpload() {
			counts.merge++;
			if (failMergeStatus) {
				const error = new Error("bad request");
				error.status = failMergeStatus;
				throw error;
			}
			if (counts.merge === 1) {
				const error = new Error("server error");
				error.status = 503;
				throw error;
			}
			return { file_info: "fi-retry", ttl: 300 };
		},
	});
	try {
		const ok = await uploadFile(stub(), { type: "private", openid: "u1" }, file, { log: silentLog });
		assert.equal(ok.fileInfo, "fi-retry");
		assert.equal(counts.put, 2);
		assert.equal(counts.part, 2);
		assert.equal(counts.merge, 2);

		await assert.rejects(
			() => uploadFile(stub(400), { type: "private", openid: "u1" }, file, { log: silentLog }),
			/bad request/,
		);
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
});

test("桥：长文本 + 3 个文件时给文件留额度", async () => {

	const dir = await fs.promises.mkdtemp(path.join(process.cwd(), "test", "tmp-quota-media-"));
	const files = [];
	for (let i = 0; i < 3; i++) {
		const file = path.join(dir, `f${i}.txt`);
		await fs.promises.writeFile(file, "x");
		files.push(file);
	}
	const fake = createFakePi();
	const sends = [];
	const media = [];
	const api = {
		auth: { getToken: async () => "t" },
		async sendText(_target, content, meta) {
			sends.push({ content, ...meta });
		},
		async sendTyping() {},
		async sendMedia(_target, fileInfo, meta) {
			media.push({ fileInfo, ...meta });
		},
		async uploadPrepare() {
			return { upload_id: "u", block_size: "1", parts: [{ index: 1, presigned_url: "http://mock/1", block_size: "1" }] };
		},
		async putPresigned() {},
		async uploadPartFinish() {},
		async finishUpload() {
			return { file_info: "fi", ttl: 300 };
		},
	};
	const bridge = new QqBridge({
		pi: fake.pi,
		api,
		config: normalizeConfig({ allowAll: true, chunkChars: 100, maxChunks: 4 }),
		log: silentLog,
	});
	try {
		bridge.enqueue({
			kind: "private", chatId: "user-1", userId: "user-1", msgId: "msg-q",
			text: "画图", attachments: [], receivedAt: Date.now(),
		});
		await waitFor(() => fake.sent.length === 1);
		bridge.onAgentStart();
		const text = `很长的回答${"啊".repeat(500)}\n` + files.map((f) => `[[file:${f}]]`).join("\n");
		bridge.onMessageEnd({ role: "assistant", content: text });
		bridge.onAgentSettled(false);
		await waitFor(() => media.length === 3, { label: "3 个文件" });
		assert.equal(sends.length, 1, "单聊额度 4：1 段文字 + 3 个文件");
		assert.equal(media.length, 3);
	} finally {
		bridge.stop?.();
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
});

test("桥：[[file:...]] 会被摘掉并作为富媒体发送", async () => {
	const dir = await fs.promises.mkdtemp(path.join(process.cwd(), "test", "tmp-bridge-media-"));
	const file = path.join(dir, "chart.png");
	await fs.promises.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	const fake = createFakePi();
	const media = [];
	const sends = [];
	const api = {
		auth: { getToken: async () => "test-token" },
		async sendText(_target, content, meta) {
			sends.push({ target: _target, content, ...meta });
		},
		async sendTyping() {},
		async sendMedia(_target, fileInfo, meta) {
			media.push({ target: _target, fileInfo, ...meta });
		},
		async uploadPrepare() {
			return { upload_id: "u1", block_size: "4", parts: [{ index: 0, presigned_url: "http://mock/0", block_size: "4" }] };
		},
		async putPresigned() {},
		async uploadPartFinish() {},
		async finishUpload() {
			return { file_info: "fi-1", ttl: 300 };
		},
	};
	const bridge = new QqBridge({ pi: fake.pi, api, config: normalizeConfig({ allowAll: true }), log: silentLog });
	try {
		bridge.enqueue({
			kind: "private",
			chatId: "user-1",
			userId: "user-1",
			msgId: "msg-1",
			text: "画个图",
			attachments: [],
			receivedAt: Date.now(),
		});
		await waitFor(() => fake.sent.length === 1, { label: "注入" });
		bridge.onAgentStart();
		bridge.onMessageEnd({ role: "assistant", content: `给你：\n[[file:${file}]]` });
		bridge.onAgentSettled(false);
		await waitFor(() => media.length === 1, { label: "媒体发送" });
		assert.equal(sends.length, 1);
		assert.equal(sends[0].content, "给你：");
		assert.equal(media[0].fileInfo, "fi-1");
		assert.equal(media[0].msgId, "msg-1");
		assert.equal(media[0].target.type, "private");
	} finally {
		bridge.stop?.();
		await sleep(10);
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
});
