/**
 * `/qq start|stop` 端到端：真 pi（rpc）里执行命令，
 * 验证它拉起后台 pi、服务连网关、状态文件出现、stop 后清理。不调用模型。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isServiceAlive, readServiceState, serviceStatePath } from "../src/service.js";
import { startMockQq } from "./mock-qq.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qqbot-svccmd-"));
const configPath = path.join(dir, "config.json");
const sessionDir = path.join(dir, "sessions");
fs.mkdirSync(sessionDir, { recursive: true });

const mock = await startMockQq();
fs.writeFileSync(
	configPath,
	JSON.stringify(
		{
			appId: "1234567890",
			clientSecret: "svc-cmd-secret",
			sandbox: false,
			allowAll: true,
			endpoints: { token: `${mock.base}/app/getAppAccessToken`, api: mock.base, gateway: mock.wsUrl },
			log: { file: path.join(dir, "svc-cmd.log"), level: "debug" },
		},
		null,
		2,
	),
);

const child = spawn("pi", ["--mode", "rpc", "--session-dir", sessionDir, "--no-extensions", "--extension", root], {
	cwd: dir,
	env: { ...process.env, QQBOT_CONFIG: configPath },
	stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (c) => (output += c.toString()));
child.stderr.on("data", (c) => (output += c.toString()));

const stateFile = serviceStatePath(dir);
const deadline = Date.now() + 60_000;

async function until(check, label) {
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) {
			console.error(`✖ 超时：${label}\n--- 输出 ---\n${output.slice(-4000)}`);
			child.kill("SIGTERM");
			await mock.stop();
			process.exit(1);
		}
		await new Promise((r) => setTimeout(r, 200));
	}
}

function command(message) {
	child.stdin.write(JSON.stringify({ id: String(Date.now()), type: "prompt", message }) + "\n");
}

try {
	await until(() => mock.state.identifies.length === 1, "本地 pi 连上网关");
	console.log("✔ 本地 pi 先连上（identify 1）");

	command("/qq start");
	await until(() => mock.state.identifies.length === 2, "后台服务连上网关");
	const state = await until(() => {
		const s = readServiceState(stateFile);
		return s && isServiceAlive(s) ? s : null;
	}, "服务状态文件");
	console.log(`✔ 服务已启动：pid ${state.pid} · 会话 ${state.sessionId}`);

	command("/qq stop");
	await until(() => {
		const s = readServiceState(stateFile);
		return !s || !isServiceAlive(s);
	}, "服务停止");
	console.log("✔ /qq stop 后状态清理");

	console.log("✔ 服务命令端到端通过");
	child.kill("SIGTERM");
	await mock.stop();
	fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
} catch (err) {
	console.error(err?.stack ?? err);
	child.kill("SIGTERM");
	await mock.stop();
	process.exit(1);
}
