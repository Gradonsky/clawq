/**
 * test-clawq.ts — Integration tests for clawq CLI
 *
 * Runs clawq commands as subprocesses and validates output.
 * Tests REST commands (discover, agents, info) against the live backend
 * and a free-agent query via WebSocket.
 *
 * Usage: tsx test-clawq.ts
 */

import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { resolve } from "path";

const CLAWQ = resolve(import.meta.dirname!, "clawq.ts");
const TEST_KEY = "0a0027e9ed6a9c2c09a5f7dc4c1809be3885626fae44e6532db2b1cb692b2cb7";

// 20 MB buffer — discover output is large (200+ agents with full command data)
const MAX_BUF = 20 * 1024 * 1024;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function run(args: string[], env?: Record<string, string>): string {
  return execFileSync("npx", ["tsx", CLAWQ, ...args], {
    encoding: "utf-8",
    timeout: 90_000,
    maxBuffer: MAX_BUF,
    env: { ...process.env, ...env },
  }).trim();
}

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    const msg = err.message || String(err);
    failures.push(`${name}: ${msg.split("\n")[0]}`);
    console.log(`  ✗ ${name}`);
    console.log(`    ${msg.split("\n")[0]}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertIncludes(str: string, sub: string, label?: string) {
  if (!str.includes(sub)) throw new Error(`${label || "output"} missing "${sub}"`);
}

// ═══════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║         clawq CLI — Integration Tests               ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

// ─── Help ────────────────────────────────────────────────────────

console.log("Help & Usage:");

test("--help shows usage text", () => {
  const out = run(["--help"]);
  assertIncludes(out, "clawq");
  assertIncludes(out, "COMMANDS");
  assertIncludes(out, "discover");
  assertIncludes(out, "agents");
  assertIncludes(out, "info");
  assertIncludes(out, "query");
  assertIncludes(out, "--json");
  assertIncludes(out, "--private-key");
});

// ─── Discover ────────────────────────────────────────────────────

console.log("\nDiscover:");

// Run discover once and validate all aspects from the cached result
test("discover returns valid JSON with all expected sections", () => {
  const out = run(["discover"]);
  const data = JSON.parse(out);

  // _meta
  assert(data._meta !== undefined, "_meta missing");
  assert(typeof data._meta.total_agents === "number", "_meta.total_agents not a number");
  assert(typeof data._meta.online_agents === "number", "_meta.online_agents not a number");
  assert(data._meta.total_agents > 0, "no agents found");
  assert(typeof data._meta.backend === "string", "_meta.backend missing");
  assert(typeof data._meta.websocket === "string", "_meta.websocket missing");

  // agents
  assert(Array.isArray(data.agents), "agents is not an array");
  assert(data.agents.length > 0, "agents array is empty");
  const first = data.agents[0];
  assert(typeof first.agent_id === "string", "agent missing agent_id");
  assert(typeof first.agent_name === "string", "agent missing agent_name");
  assert(typeof first.is_online === "boolean", "agent missing is_online");

  // online_agents
  assert(Array.isArray(data.online_agents), "online_agents is not an array");
  assert(data.online_agents.length <= data.agents.length, "more online than total");
  for (const a of data.online_agents) {
    assert(a.is_online === true, `online agent ${a.agent_id} has is_online !== true`);
  }

  // command_index
  assert(Array.isArray(data.command_index), "command_index not an array");
  assert(data.command_index.length > 0, "command_index empty");
  const cmd = data.command_index[0];
  assert(typeof cmd.usage === "string", "command missing usage");
  assert(typeof cmd.agent_id === "string", "command missing agent_id");
  assert(typeof cmd.trigger === "string", "command missing trigger");
  assert(typeof cmd.is_free === "boolean", "command missing is_free");

  // how_to_query
  assert(data.how_to_query !== undefined, "how_to_query missing");
  assert(typeof data.how_to_query.direct_command === "string", "direct_command missing");
  assert(typeof data.how_to_query.execution === "string", "execution missing");

  // networks & fee_config
  assert(data.networks !== null && data.networks !== undefined, "networks missing");
  assert(data.fee_config !== null && data.fee_config !== undefined, "fee_config missing");
});

// ─── Agents ──────────────────────────────────────────────────────

console.log("\nAgents:");

test("agents --json returns array with required fields", () => {
  const out = run(["agents", "--json"]);
  const data = JSON.parse(out);
  assert(Array.isArray(data), "agents --json did not return an array");
  assert(data.length > 0, "agents array empty");
  const agent = data[0];
  assert(typeof agent.agent_id === "string", "missing agent_id");
  assert(typeof agent.agent_name === "string", "missing agent_name");
  assert(typeof agent.is_online === "boolean", "missing is_online");
  assert(typeof agent.review_status === "string", "missing review_status");
  assert(Array.isArray(agent.commands), "commands not an array");
});

test("agents --online --json only returns online agents", () => {
  const out = run(["agents", "--online", "--json"]);
  const data = JSON.parse(out);
  assert(data.length > 0, "no online agents");
  for (const a of data) {
    assert(a.is_online === true, `agent ${a.agent_id} is not online`);
  }
});

test("agents --free --json returns agents with free commands", () => {
  const out = run(["agents", "--free", "--json"]);
  const data = JSON.parse(out);
  for (const a of data) {
    const hasFree = a.commands.some((c: any) => c.is_free === true);
    assert(hasFree, `agent ${a.agent_id} has no free commands`);
  }
});

test("agents table output has header", () => {
  const out = run(["agents"]);
  assertIncludes(out, "AGENT ID");
  assertIncludes(out, "NAME");
  assertIncludes(out, "STATUS");
});

test("agents --search with unlikely term returns no results", () => {
  const out = run(["agents", "--search", "zzzznonexistent99999"]);
  assertIncludes(out, "No agents found");
});

test("agents --online --free --json combined filters work", () => {
  const out = run(["agents", "--online", "--free", "--json"]);
  const data = JSON.parse(out);
  assert(Array.isArray(data), "combined filters didn't return array");
  for (const a of data) {
    assert(a.is_online === true, `${a.agent_id} not online`);
    const hasFree = a.commands.some((c: any) => c.is_free);
    assert(hasFree, `${a.agent_id} has no free commands`);
  }
});

// ─── Info ────────────────────────────────────────────────────────

console.log("\nInfo:");

// Find a real online agent to test info against
let testAgentId = "hotel-finder";
try {
  const agentsOut = run(["agents", "--online", "--json"]);
  const agentsData = JSON.parse(agentsOut);
  if (agentsData.length > 0) testAgentId = agentsData[0].agent_id;
} catch { /* use fallback */ }

test(`info ${testAgentId} --json returns agent with pricing`, () => {
  const out = run(["info", testAgentId, "--json"]);
  const data = JSON.parse(out);
  assert(data.agent_id === testAgentId, `agent_id mismatch: ${data.agent_id}`);
  assert(typeof data.agent_name === "string", "missing agent_name");
  assert(Array.isArray(data.commands), "commands not an array");
  if (data.commands.length > 0) {
    const cmd = data.commands[0];
    assert(typeof cmd.trigger === "string", "missing trigger");
    assert(typeof cmd.usage === "string", "missing usage");
    assert(typeof cmd.price === "number", "missing price");
    assert(typeof cmd.is_free === "boolean", "missing is_free");
    assert(typeof cmd.task_unit === "string", "missing task_unit");
  }
});

test("info nonexistent agent returns error", () => {
  try {
    run(["info", "zzz-nonexistent-agent-999", "--json"]);
    throw new Error("should have exited with error");
  } catch (err: any) {
    const output = (err.stdout || "").toString() + (err.stderr || "").toString();
    assert(output.includes("not_found") || output.includes("not found"), "error output missing not_found");
  }
});

test("info partial name suggests similar agents", () => {
  try {
    run(["info", "hotel"]);
    throw new Error("should have exited with error");
  } catch (err: any) {
    const output = (err.stdout || "").toString() + (err.stderr || "").toString();
    assert(
      output.includes("Did you mean") || output.includes("suggestions") || output.includes("hotel"),
      "no suggestions in output"
    );
  }
});

test("info pretty output shows agent details", () => {
  const out = run(["info", testAgentId]);
  assertIncludes(out, testAgentId);
  assert(out.includes("COMMANDS") || out.includes("QUERY THIS AGENT"), "no details section found");
});

// ─── Private Key Handling ────────────────────────────────────────

console.log("\nPrivate Key Handling:");

test("--private-key flag is consumed (not passed as subcommand)", () => {
  const out = run(["--private-key", TEST_KEY, "agents", "--online", "--json"]);
  const data = JSON.parse(out);
  assert(Array.isArray(data), "agents --json with --private-key failed");
});

test("PRIVATE_KEY env var works", () => {
  const out = run(["info", testAgentId, "--json"], { PRIVATE_KEY: TEST_KEY });
  const data = JSON.parse(out);
  assert(data.agent_id === testAgentId, "info with PRIVATE_KEY env failed");
});

// ─── Query (WebSocket) ──────────────────────────────────────────

console.log("\nQuery (WebSocket):");

test("query without message shows usage error", () => {
  try {
    run(["--private-key", TEST_KEY, "query"]);
    throw new Error("should have exited with error");
  } catch (err: any) {
    const output = (err.stdout || "").toString() + (err.stderr || "").toString();
    assert(output.includes("Usage") || output.includes("usage"), "no usage hint in error");
  }
});

test("query free agent --json returns response or quote", () => {
  const out = run(["--private-key", TEST_KEY, "query", "--json", "@hotel-finder help"]);
  const data = JSON.parse(out);
  assert(
    data.type === "response" || data.type === "task_quote",
    `unexpected type: ${data.type}`
  );
  if (data.type === "response") {
    assert(typeof data.content === "string", "response missing content");
    assert(data.content.length > 0, "response content is empty");
  }
});

test("query pretty output shows response sections", () => {
  const out = run(["--private-key", TEST_KEY, "query", "@hotel-finder help"]);
  assert(
    out.includes("clawq") || out.includes("Query") || out.includes("RESPONSE") || out.includes("PAYMENT"),
    "pretty output missing expected sections"
  );
});

// ─── Edge Cases ──────────────────────────────────────────────────

console.log("\nEdge Cases:");

test("unknown command shows error", () => {
  try {
    run(["foobar"]);
    throw new Error("should have exited with error");
  } catch (err: any) {
    const output = (err.stdout || "").toString() + (err.stderr || "").toString();
    assert(output.includes("Unknown command"), "no 'Unknown command' in output");
  }
});

// ─── Summary ─────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log("═══════════════════════════════════════════════════════");

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ✗ ${f}`);
  }
  console.log("");
  process.exit(1);
} else {
  console.log("\n  All tests passed!\n");
}
