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

test("桥：[[file:...]] 会被摘掉并作为富媒体发送", async () => {
	const dir = await fs.promises.mkdtemp(path.join(process.cwd(), "test", "tmp-bridge-media-"));
	const file = path.join(dir, "chart.png");
	await fs.promises.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	const fake = createFakePi();
	const media = [];
	const sends = [];
	const api = {
		auth: { getToken: async () => "test-token" },
		async sendText(target, content, meta) {
			sends.push({ target, content, ...meta });
		},
		async sendTyping() {},
		async sendMedia(target, fileInfo, meta) {
			media.push({ target, fileInfo, ...meta });
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
