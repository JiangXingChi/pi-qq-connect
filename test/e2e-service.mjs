/**
 * 后台服务端到端：启动 bin/pi-qqbot.mjs（detached 的常驻 pi），
 * 验证它写状态+心跳、连上网关、SIGTERM 后清理，不调用模型。
 *
 * 跑法：node test/e2e-service.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isServiceAlive, readServiceState, serviceStatePath } from "../src/service.js";
import { startMockQq } from "./mock-qq.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qqbot-svc-"));
const configPath = path.join(dir, "config.json");
const sessionDir = path.join(dir, "sessions");
fs.mkdirSync(sessionDir, { recursive: true });

const mock = await startMockQq();
fs.writeFileSync(
	configPath,
	JSON.stringify(
		{
			appId: "1234567890",
			clientSecret: "svc-secret",
			sandbox: false,
			allowAll: true,
			endpoints: { token: `${mock.base}/app/getAppAccessToken`, api: mock.base, gateway: mock.wsUrl },
			log: { file: path.join(dir, "svc.log"), level: "debug" },
		},
		null,
		2,
	),
);

const child = spawn(process.execPath, [path.join(root, "bin", "pi-qqbot.mjs"), "--cwd", dir, "--session-id", "pi-qq-e2e-service"], {
	cwd: dir,
	env: { ...process.env, QQBOT_CONFIG: configPath },
	stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (c) => (output += c.toString()));
child.stderr.on("data", (c) => (output += c.toString()));

const deadline = Date.now() + 45_000;
async function until(check, label) {
	for (;;) {
		const value = check();
		if (value) return value;
		if (Date.now() > deadline) {
			console.error(`✖ 超时：${label}\n--- 服务输出 ---\n${output.slice(-3000)}`);
			child.kill("SIGTERM");
			await mock.stop();
			process.exit(1);
		}
		await new Promise((r) => setTimeout(r, 200));
	}
}

await until(() => mock.state.identifies.length > 0, "服务连上网关");
console.log("✔ 后台服务已连上网关（identify 1 次）");

const stateFile = serviceStatePath(dir);
const state = await until(() => readServiceState(stateFile), "状态文件写入");
await until(() => isServiceAlive(state), "心跳有效");
console.log(`✔ 状态文件：pid ${state.pid} · 会话 ${state.sessionId} · 心跳有效`);

if (state.pid !== child.pid) {
	console.error(`✖ 状态文件 pid(${state.pid}) 与服务进程(${child.pid}) 不一致`);
	child.kill("SIGTERM");
	await mock.stop();
	process.exit(1);
}

// 第二个服务实例应被拒绝
const second = spawn(process.execPath, [path.join(root, "bin", "pi-qqbot.mjs"), "--cwd", dir, "--session-id", "dup"], {
	cwd: dir,
	env: { ...process.env, QQBOT_CONFIG: configPath },
	stdio: ["ignore", "pipe", "pipe"],
});
const secondExit = await new Promise((resolve) => {
	const timer = setTimeout(() => resolve("timeout"), 8000);
	second.on("exit", (code) => {
		clearTimeout(timer);
		resolve(code);
	});
});
if (secondExit === "timeout") {
	console.error("✖ 第二个服务实例没有退出");
	second.kill("SIGTERM");
	child.kill("SIGTERM");
	await mock.stop();
	process.exit(1);
}
if (mock.state.identifies.length !== 1) {
	console.error(`✖ 第二个实例抢了网关：identify ${mock.state.identifies.length} 次`);
	child.kill("SIGTERM");
	await mock.stop();
	process.exit(1);
}
console.log("✔ 第二个服务实例被拒绝，网关仍只有一条连接");

child.kill("SIGTERM");
const exitDeadline = Date.now() + 10_000;
while (child.exitCode === null && Date.now() < exitDeadline) await new Promise((r) => setTimeout(r, 100));

await until(() => !readServiceState(stateFile) || !isServiceAlive(readServiceState(stateFile)), "退出后清理状态");
console.log("✔ SIGTERM 后服务退出、状态文件清理");

if (mock.state.identifies.length !== 1) {
	console.error(`✖ 服务期间网关重连了：identify ${mock.state.identifies.length} 次`);
	await mock.stop();
	process.exit(1);
}

console.log("✔ 服务模式端到端通过");
await mock.stop();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
