/**
 * 端到端：真 pi（--mode rpc）加载本扩展，对接 mock QQ。
 *
 * 跑法：node test/e2e.mjs [--timeout 180]
 * 会真实调用两次模型（默认 provider/model），提示词是「请只回复：pong」与「请只回复：pong2」。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { c2cEvent, startMockQq } from "./mock-qq.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutArg = process.argv.indexOf("--timeout");
const timeoutMs = timeoutArg > -1 ? Number(process.argv[timeoutArg + 1]) * 1000 : 180_000;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qq-connect-e2e-"));
const configPath = path.join(dir, "config.json");
const logPath = path.join(dir, "e2e.log");
const sessionDir = path.join(dir, "sessions");
fs.mkdirSync(sessionDir, { recursive: true });

const mock = await startMockQq();
fs.writeFileSync(
	configPath,
	JSON.stringify(
		{
			appId: "1234567890",
			clientSecret: "e2e-secret",
			sandbox: false,
			allowAll: true,
			envelope: false,
			endpoints: { token: `${mock.base}/app/getAppAccessToken`, api: mock.base, gateway: mock.wsUrl },
			log: { file: logPath, level: "debug" },
		},
		null,
		2,
	),
);

const child = spawn("pi", ["--mode", "rpc", "--session-dir", sessionDir, "--no-extensions", "--extension", root], {
	cwd: dir,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, PIQQCONNECT_CONFIG: configPath },
});

let stderr = "";
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString();
});
let rpcOut = "";
child.stdout.on("data", (chunk) => {
	// 保持管道不阻塞；同时留一份给「命令通道仍可用」断言用
	rpcOut += chunk.toString();
});

function fail(message) {
	console.error(`✖ ${message}`);
	if (stderr.trim()) console.error("--- pi stderr ---\n" + stderr.trim());
	console.error(`--- 扩展日志 ---\n${safeLog()}`);
	child.kill("SIGTERM");
	void mock.stop().then(() => process.exit(1));
}

function safeLog() {
	try {
		return fs.readFileSync(logPath, "utf8").trim() || "（空）";
	} catch {
		return "（无日志）";
	}
}

const deadline = Date.now() + timeoutMs;
async function until(check, label) {
	for (;;) {
		if (check()) return;
		if (Date.now() > deadline) return fail(`等待超时：${label}`);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

try {
	await until(() => mock.state.identifies.length > 0, "扩展连上网关并 identify");
	console.log("✔ 网关 identify 成功");

	mock.dispatch(
		"C2C_MESSAGE_CREATE",
		c2cEvent({ msgId: "e2e-msg-1", userOpenId: "e2e-user", content: "请只回复：pong" }),
		"e2e-msg-1",
	);

	await until(() => mock.state.sends.length > 0, "Pi 回复到 QQ");
	if (mock.state.typings.length > 0) console.log(`✔ 收到「正在输入」提示 ${mock.state.typings.length} 次`);
	const sent = mock.state.sends[0];
	console.log(`✔ QQ 收到回复：${JSON.stringify(sent.body)}`);

	if (!/pong/i.test(String(sent.body.content ?? ""))) throw new Error("回复内容里没有 pong");
	if (sent.body.msg_id !== "e2e-msg-1") throw new Error(`msg_id 不对：${sent.body.msg_id}`);
	if (!(sent.body.msg_seq >= 1 && sent.body.msg_seq < 65536)) throw new Error(`msg_seq 不在 0..65535：${sent.body.msg_seq}`);
	if (sent.type !== "private") throw new Error(`目标类型不对：${sent.type}`);

	// /new：QQ 里发命令，切到新 Pi 会话，网关不断，命令保持可用，新会话还能继续聊
	const identifiesBefore = mock.state.identifies.length;
	const sendsBefore = mock.state.sends.length;
	const newStartedAt = Date.now();
	mock.dispatch("C2C_MESSAGE_CREATE", c2cEvent({ msgId: "e2e-new-1", userOpenId: "e2e-user", content: "/new" }), "e2e-new-1");
	await until(
		() => mock.state.sends.slice(sendsBefore).some((s) => /已开新会话/.test(String(s.body.content ?? ""))),
		"新会话回执",
	);
	const switchMs = Date.now() - newStartedAt;
	// 回执来自 ctx.newSession() 的 resolve，是性能冒烟值，不作为回归门槛；
	// 真正的门槛是后面「新会话里继续对话」「/qq status 仍可用」「日志无 30 秒看门狗」
	console.log(`✔ QQ 收到「已开新会话」回执（${switchMs}ms）`);

	mock.dispatch("C2C_MESSAGE_CREATE", c2cEvent({ msgId: "e2e-msg-2", userOpenId: "e2e-user", content: "请只回复：pong2" }), "e2e-msg-2");
	await until(() => mock.state.sends.some((s) => /pong2/i.test(String(s.body.content ?? ""))), "新会话里继续对话");
	console.log("✔ 新会话里继续对话成功");
	if (mock.state.identifies.length !== identifiesBefore) throw new Error("/new 期间网关被重连了");

	// 换会话后 QQ 侧的桥还活着
	mock.dispatch("C2C_MESSAGE_CREATE", c2cEvent({ msgId: "e2e-status-1", userOpenId: "e2e-user", content: "/qq status" }), "e2e-status-1");
	await until(() => mock.state.sends.some((s) => /网关：/.test(String(s.body.content ?? ""))), "换会话后 QQ 侧 /qq status 仍可用");
	console.log("✔ 换会话后 QQ 侧 /qq status 仍可用");

	// 换会话后 pi 自己的命令通道也必须仍可用：走 RPC prompt 才真正用到 pi.registerCommand
	// （QQ 侧的 /qq 由桥直接处理，绕过了命令注册，测不出 0.4.0 那个 bug）
	child.stdin.write(JSON.stringify({ id: "e2e-cmd-1", type: "prompt", message: "/qq status" }) + "\n");
	await until(() => /配置：/.test(rpcOut), "换会话后 pi 命令通道可用");
	console.log("✔ 换会话后 pi 命令通道可用（/qq 重新注册成功）");
	const logText = safeLog();
	if (/stale after session replacement/i.test(logText)) throw new Error("换会话后出现 stale 报错");
	if (/换会话 30 秒内没有完成/.test(logText)) throw new Error("换会话没收到 session_start，走了 30 秒看门狗");
	if (/QQ 桥已暂停/.test(logText)) throw new Error("换会话后桥被误判失效");

	const sessionFiles = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
	if (sessionFiles.length < 2) throw new Error(`新会话没有落盘，只有 ${sessionFiles.length} 个 session 文件`);
	console.log(`✔ 已生成 ${sessionFiles.length} 个 session 文件`);

	console.log("✔ 端到端通过（真 pi + mock QQ）");
	child.kill("SIGTERM");
	await mock.stop();
	process.exit(0);
} catch (err) {
	fail(err?.stack ?? String(err));
}
