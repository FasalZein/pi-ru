/**
 * Integration test: a real `pi` process loads the extension without error.
 *
 * pi-ru works at the input seam (`pi.on("input")`), not as a registered command,
 * so it intentionally does NOT appear in `get_commands`. What this test proves
 * is the thing unit tests can't: the extension file actually loads inside a real
 * pi process (jiti import succeeds, the default export runs, the input handler
 * registers) with no load error.
 *
 * Uses RPC mode + `get_commands`, which makes NO model call, so it is free and
 * deterministic. The transform logic itself is covered by the unit tests.
 *
 * Skips automatically if the `pi` binary is not on PATH.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const piOnPath = spawnSync("pi", ["--version"], { encoding: "utf8" });
const PI_AVAILABLE = piOnPath.status === 0;

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/**
 * Start pi in RPC mode with only this extension, send one request, and resolve
 * with { response, stderr }. Splits stdout on \n only, per the RPC framing contract.
 */
function rpcRequest(request, { timeoutMs = 30000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"pi",
			["--mode", "rpc", "--no-extensions", "-e", entry, "--no-session"],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let out = "";
		let err = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error("rpc request timed out"));
		}, timeoutMs);

		child.stderr.on("data", (chunk) => {
			err += chunk.toString();
		});
		child.stdout.on("data", (chunk) => {
			out += chunk.toString();
			for (const line of out.split("\n")) {
				if (!line.trim()) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.id === request.id && msg.type === "response") {
					settled = true;
					clearTimeout(timer);
					child.kill("SIGKILL");
					resolve({ response: msg, stderr: err });
					return;
				}
			}
		});
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(e);
		});
		child.stdin.write(`${JSON.stringify(request)}\n`);
	});
}

test("pi loads the pi-ru extension without error (RPC, no model call)", async (t) => {
	if (!PI_AVAILABLE) return t.skip("pi binary not on PATH");

	const { response, stderr } = await rpcRequest({ id: "1", type: "get_commands" });

	// RPC + extension subsystem came up cleanly.
	assert.equal(response.success, true);
	assert.ok(Array.isArray(response.data?.commands), "expected a commands array");

	// The extension loaded without a load-time error.
	assert.doesNotMatch(
		stderr,
		/pi-ru|index\.ts|failed to load|extension error/i,
		`unexpected extension load error in stderr:\n${stderr}`,
	);

	// pi-ru is an input-seam extension, so it must NOT register a /ru command.
	const ru = (response.data.commands ?? []).find((c) => c.name === "ru");
	assert.equal(ru, undefined, "pi-ru should not register a /ru command (it uses the input seam)");
});
