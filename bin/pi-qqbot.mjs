#!/usr/bin/env node
/**
 * 常驻启动器：拉起 `pi --mode rpc` 并挂本扩展，保持 stdin 不关，pi 就不会退出。
 * QQ 一直在线的同时，这条 pi 会话也持久化在 --session-id 指定的文件里。
 *
 * 用法：
 *   ./bin/pi-qqbot.mjs                    # 默认 session-id=pi-qqbot，cwd=当前目录
 *   ./bin/pi-qqbot.mjs --cwd ~/Agent/Core # 指定 pi 的工作目录
 *   ./bin/pi-qqbot.mjs --session-id qq    # 指定会话文件
 *   ./bin/pi-qqbot.mjs --no-restart       # 退出后不自动重启
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configPath } from "../src/config.js";
import {
	isServiceAlive,
	readServiceState,
	removeServiceState,
	serviceStatePath,
	writeServiceState,
} from "../src/service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const baseDir = path.dirname(configPath());
const stateFile = serviceStatePath(baseDir);

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const value = process.argv[index + 1];
	return value && !value.startsWith("--") ? value : fallback;
}

const sessionId = arg("session-id", "pi-qqbot");
const cwd = arg("cwd", process.cwd());
const restart = !process.argv.includes("--no-restart");
const extra = [];
const modelIndex = process.argv.indexOf("--model");
const modelValue = modelIndex > -1 ? process.argv[modelIndex + 1] : undefined;
if (modelValue && !modelValue.startsWith("--")) extra.push("--model", modelValue);

let child;
let stopping = false;
let restartDelay = 3000;
let startedAt = 0;
const startedIso = new Date().toISOString();

function beat() {
	try {
		writeServiceState(stateFile, {
			pid: process.pid,
			startedAt: startedIso,
			heartbeatAt: new Date().toISOString(),
			sessionId: String(sessionId),
			cwd: String(cwd),
			version: pkg.version,
		});
	} catch {
		// 状态文件写不进去不影响机器人
	}
}

function scheduleRestart() {
	restartDelay = Date.now() - startedAt > 60_000 ? 3000 : Math.min(restartDelay * 2, 60_000);
	if (restart) {
		setTimeout(launch, restartDelay);
	} else {
		console.error("[pi-qqbot] --no-restart：服务结束");
		removeServiceState(stateFile);
		process.exit(0);
	}
}

function launch() {
	// --no-extensions：只加载本插件，避免机器上另一份 pi-qqbot 被自动发现、两个网关互相抢锁
	const args = ["--mode", "rpc", "--no-extensions", "--session-id", String(sessionId), "--extension", root, ...extra];
	console.error(`[pi-qqbot] 启动：pi ${args.join(" ")}（cwd=${cwd}）`);
	startedAt = Date.now();
	let launched;
	try {
		launched = spawn("pi", args, {
			cwd: String(cwd),
			stdio: ["pipe", "inherit", "inherit"],
			env: { ...process.env, QQBOT_SERVICE_PID: String(process.pid) },
		});
	} catch (err) {
		console.error(`[pi-qqbot] 无法启动 pi：${err.message}`);
		scheduleRestart();
		return;
	}
	child = launched;
	let ended = false;
	const onEnd = (why) => {
		if (ended) return;
		ended = true;
		child = undefined;
		if (stopping) return;
		console.error(`[pi-qqbot] pi ${why}`);
		scheduleRestart();
	};
	launched.once("exit", (code, signal) => onEnd(`退出（code=${code} signal=${signal}）`));
	// spawn 失败只发 error/close，不会发 exit；必须走同一套重启逻辑
	launched.once("error", (err) => onEnd(`无法启动：${err.message}`));
	launched.once("close", (code) => onEnd(`关闭（code=${code}）`));
}

function shutdown(signal) {
	stopping = true;
	console.error(`[pi-qqbot] 收到 ${signal}，停止`);
	try {
		child?.stdin?.end();
		child?.kill("SIGTERM");
	} catch {
		// ignore
	}
	// 等 pi 自己收尾（会释放锁）；超时只结束本进程，不强杀子进程
	const waiter = setInterval(() => {
		if (!child) {
			clearInterval(waiter);
			process.exit(0);
		}
	}, 100);
	waiter.unref?.();
	setTimeout(() => {
		if (child) {
			console.error("[pi-qqbot] 子进程 8 秒内未退出，强制结束，避免留下占网关的孤儿");
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
		process.exit(0);
	}, 8000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => removeServiceState(stateFile));

// 已经有一个健康的服务时，第二个实例直接退出，避免两个 pi 抢网关/覆盖心跳
const existing = readServiceState(stateFile);
if (existing && existing.pid !== process.pid && isServiceAlive(existing)) {
	console.error(`[pi-qqbot] 已有后台服务在运行（pid ${existing.pid}），本进程退出`);
	// systemd 下让它可见地失败（配合 StartLimitBurst=3），否则 unit 看起来是 inactive；
	// 手动 /qq start 的场景则干净退出，避免父进程误判。
	process.exit(process.env.INVOCATION_ID ? 1 : 0);
}

beat();
setInterval(beat, 15_000);
launch();
