import { describe, expect, it } from "vitest";

import {
	buildRestrictedSubprocessEnv,
	containsInternalUrl,
	findDangerousShellPattern,
	guardWorkspacePathAccess,
	validateResolvedUrl,
	validateUrlTarget,
} from "../src/security/index.js";

describe("security helpers", () => {
	it("blocks private and localhost SSRF targets", async () => {
		await expect(validateUrlTarget("http://127.0.0.1")).resolves.toEqual(
			expect.objectContaining({ ok: false }),
		);
		await expect(validateUrlTarget("http://10.0.0.1")).resolves.toEqual(
			expect.objectContaining({ ok: false }),
		);
		await expect(validateUrlTarget("http://[::1]")).resolves.toEqual(
			expect.objectContaining({ ok: false }),
		);
	});

	it("allows whitelisted CIDR targets", async () => {
		await expect(
			validateResolvedUrl("http://100.64.0.10", {
				ssrfWhitelist: ["100.64.0.0/10"],
			}),
		).resolves.toEqual({ ok: true });
	});

	it("detects internal URLs embedded in shell command text", async () => {
		await expect(
			containsInternalUrl('curl "http://127.0.0.1:8080/status"'),
		).resolves.toBe(true);
	});

	it("detects dangerous shell command patterns", () => {
		expect(findDangerousShellPattern("rm -rf ./build")).toBeTruthy();
		expect(findDangerousShellPattern("echo hello")).toBeNull();
	});

	it("rejects path traversal and workspace escape", () => {
		expect(
			guardWorkspacePathAccess("../secrets.txt", {
				cwd: "E:\\Web\\.tauri\\nanobot",
				workspaceRoot: "E:\\Web\\.tauri\\nanobot",
			}),
		).toContain("Path traversal");
		expect(
			guardWorkspacePathAccess("type C:\\Windows\\system.ini", {
				cwd: "E:\\Web\\.tauri\\nanobot",
				workspaceRoot: "E:\\Web\\.tauri\\nanobot",
			}),
		).toContain("escapes the workspace boundary");
	});

	it("keeps a minimal subprocess env plus allowed keys", () => {
		const env = buildRestrictedSubprocessEnv({
			platform: "win32",
			env: {
				PATH: "C:\\Windows\\System32",
				SYSTEMROOT: "C:\\Windows",
				SECRET_TOKEN: "hidden",
				APPDATA: "C:\\Users\\test\\AppData\\Roaming",
			},
			allowedEnvKeys: ["SECRET_TOKEN"],
		});

		expect(env).toEqual({
			PATH: "C:\\Windows\\System32",
			SYSTEMROOT: "C:\\Windows",
			APPDATA: "C:\\Users\\test\\AppData\\Roaming",
			SECRET_TOKEN: "hidden",
		});
	});

	it("blocks IPv4-mapped IPv6 addresses as SSRF targets", async () => {
		await expect(
			validateResolvedUrl("http://[::ffff:127.0.0.1]"),
		).resolves.toEqual(expect.objectContaining({ ok: false }));
		await expect(
			validateResolvedUrl("http://[::ffff:10.0.0.1]"),
		).resolves.toEqual(expect.objectContaining({ ok: false }));
		await expect(
			validateResolvedUrl("http://[::ffff:192.168.1.1]"),
		).resolves.toEqual(expect.objectContaining({ ok: false }));
	});

	it("rejects file:// and other non-http protocols", async () => {
		await expect(validateUrlTarget("file:///etc/passwd")).resolves.toEqual(
			expect.objectContaining({ ok: false }),
		);
		await expect(validateUrlTarget("ftp://example.com")).resolves.toEqual(
			expect.objectContaining({ ok: false }),
		);
		await expect(
			validateUrlTarget("data:text/html,<h1>hi</h1>"),
		).resolves.toEqual(expect.objectContaining({ ok: false }));
	});

	it("blocks the cloud metadata endpoint (169.254.169.254)", async () => {
		await expect(
			validateResolvedUrl("http://169.254.169.254/latest/meta-data/"),
		).resolves.toEqual(expect.objectContaining({ ok: false }));
	});

	it("detects DNS rebinding via hostname resolver", async () => {
		await expect(
			validateUrlTarget("http://legit-looking-server.example.com", {
				resolveHostname: async () => ["127.0.0.1"],
			}),
		).resolves.toEqual(expect.objectContaining({ ok: false }));
	});

	it("detects multiple dangerous shell patterns beyond rm -rf", () => {
		expect(findDangerousShellPattern("del /f C:\\file")).toBeTruthy();
		expect(findDangerousShellPattern("rmdir /s C:\\tmp")).toBeTruthy();
		expect(findDangerousShellPattern("format C:")).toBeTruthy();
		expect(
			findDangerousShellPattern("dd if=/dev/zero of=/dev/sda"),
		).toBeTruthy();
		expect(findDangerousShellPattern(":(){ :|:& };:")).toBeTruthy();
		expect(findDangerousShellPattern("shutdown /s /t 0")).toBeTruthy();
	});

	it("allows safe commands within the workspace boundary", () => {
		expect(
			guardWorkspacePathAccess("dir E:\\Web\\.tauri\\nanobot\\src", {
				cwd: "E:\\Web\\.tauri\\nanobot",
				workspaceRoot: "E:\\Web\\.tauri\\nanobot",
			}),
		).toBeNull();
		expect(
			guardWorkspacePathAccess("echo hello world", {
				cwd: "E:\\Web\\.tauri\\nanobot",
				workspaceRoot: "E:\\Web\\.tauri\\nanobot",
			}),
		).toBeNull();
	});

	it("rejects absolute paths outside workspace even without traversal", () => {
		expect(
			guardWorkspacePathAccess("type D:\\Secrets\\passwords.txt", {
				cwd: "E:\\Web\\.tauri\\nanobot",
				workspaceRoot: "E:\\Web\\.tauri\\nanobot",
			}),
		).toContain("escapes the workspace boundary");
	});

	it("strips sensitive env vars on unix-like platforms", () => {
		const env = buildRestrictedSubprocessEnv({
			platform: "linux",
			env: {
				PATH: "/usr/bin",
				HOME: "/home/user",
				LANG: "en_US.UTF-8",
				TERM: "xterm",
				SECRET_TOKEN: "hidden",
				API_KEY: "secret123",
				AWS_SECRET_ACCESS_KEY: "aws-secret",
			},
		});

		expect(env).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/user",
			LANG: "en_US.UTF-8",
			TERM: "xterm",
		});
		expect(env).not.toHaveProperty("SECRET_TOKEN");
		expect(env).not.toHaveProperty("API_KEY");
		expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
	});
});
