/**
 * 测试用：假 Pi 扩展 API、假 ctx、临时配置。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createFakePi() {
	const handlers = new Map();
	const sent = [];
	const commands = new Map();
	const commandRegistrations = [];
	const pi = {
		streaming: false,
		on(name, fn) {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
			return () => {
				const current = handlers.get(name) ?? [];
				handlers.set(name, current.filter((item) => item !== fn));
			};
		},
		registerCommand(name, options) {
			commandRegistrations.push(name);
			commands.set(name, options);
		},
		sendUserMessage(content, options) {
			if (pi.streaming) throw new Error("Cannot send a user message while the agent is streaming");
			sent.push({ content, options, at: Date.now() });
			// 真实 Pi 会对注入的消息发 before_agent_start；假 pi 在下一个微任务补上，
			// 否则桥会一直等不到“轮次开始”，测试会卡在注入看门狗里。
			const prompt = typeof content === "string"
				? content
				: (Array.isArray(content) ? content.find((part) => part?.type === "text")?.text : "") ?? "";
			queueMicrotask(async () => {
				for (const fn of handlers.get("before_agent_start") ?? []) {
					await fn({ messageType: "user", prompt });
				}
			});
		},
	};
	return {
		pi,
		sent,
		commands,
		commandRegistrations,
		async emit(name, payload, ctx) {
			for (const fn of handlers.get(name) ?? []) await fn(payload, ctx);
		},
		handlerCount(name) {
			return (handlers.get(name) ?? []).length;
		},
	};
}

export function createFakeCtx() {
	const notifications = [];
	const statuses = [];
	const newSessions = [];
	const sessionInfo = [];
	return {
		notifications,
		statuses,
		newSessions,
		sessionInfo,
		async newSession(options = {}) {
			newSessions.push(options);
			await options.setup?.({
				appendSessionInfo(name) {
					sessionInfo.push(name);
				},
			});
			return { cancelled: false };
		},
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus(key, text) {
				statuses.push({ key, text });
			},
		},
		sessionManager: {
			getSessionId: () => "test-session-id",
			getSessionFile: () => "/tmp/test-session.jsonl",
		},
	};
}

let tempDir;
export function tempConfigPath() {
	if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qq-connect-test-"));
	return path.join(tempDir, `config-${Math.random().toString(36).slice(2)}.json`);
}

export function writeConfig(configPath, config) {
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
	return configPath;
}

export async function waitFor(check, { timeoutMs = 5000, intervalMs = 25, label = "条件" } = {}) {
	const started = Date.now();
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
