/**
 * clawq — CLI gateway for the Teneo Agent Network
 *
 * Discover, inspect, and query AI agents on the Teneo Protocol.
 * Supports free and paid agents with automatic x402 micropayment signing.
 * Designed for both humans and AI agents — every command supports --json output.
 *
 * Usage:
 *   clawq discover                                # full JSON manifest: all agents, commands, pricing, networks
 *   clawq agents                                  # list all public agents
 *   clawq agents --online --json                  # machine-readable online agents
 *   clawq info <agent-id>                         # show agent details + commands + pricing
 *   clawq info <agent-id> --json                  # machine-readable agent details
 *   clawq query "@agent-id command args"          # send a direct command via WebSocket
 *   clawq query "find me a hotel"                 # free-form query (coordinator picks agent)
 *
 * Authentication (pick one):
 *   clawq --private-key <key> query "..."         # inline key
 *   PRIVATE_KEY=<key> clawq query "..."           # env var
 *   echo "PRIVATE_KEY=<key>" > .env               # .env file (auto-loaded)
 *
 * Environment:
 *   PRIVATE_KEY=<64-hex-chars>    # wallet key for authentication + payments (generates ephemeral if not set)
 *   BACKEND_URL=<url>             # override backend (default: https://backend.developer.chatroom.teneo-protocol.ai)
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import WebSocket from "ws";
import { type Hex, toHex, keccak256, encodePacked, defineChain } from "viem";
import { privateKeyToAccount, generatePrivateKey, signTypedData } from "viem/accounts";

// ─── .env loader (zero deps) ────────────────────────────────────────
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), ".env");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* no .env file, that's fine */ }
}
loadEnv();

// ─── CLI Parsing ────────────────────────────────────────────────────

// Extract --private-key value before general flag parsing
function extractKeyFlag(): string | undefined {
  const idx = process.argv.indexOf("--private-key");
  if (idx !== -1 && process.argv[idx + 1]) {
    const val = process.argv[idx + 1];
    // Remove both from argv so they don't pollute other parsing
    process.argv.splice(idx, 2);
    return val;
  }
  return undefined;
}

const CLI_KEY = extractKeyFlag();

const allArgs = process.argv.slice(2);
const args = allArgs.filter(a => !a.startsWith("--"));
const flags = allArgs.filter(a => a.startsWith("--"));
const [command, ...rest] = args;

// ─── Configuration ──────────────────────────────────────────────────
const BACKEND_URL = process.env.BACKEND_URL || "https://backend.developer.chatroom.teneo-protocol.ai";
const WS_URL = BACKEND_URL.replace("https://", "wss://").replace("http://", "ws://") + "/ws";

const RAW_KEY = CLI_KEY || process.env.PRIVATE_KEY;
const PRIVATE_KEY: `0x${string}` = RAW_KEY
  ? (RAW_KEY.startsWith("0x") ? RAW_KEY : `0x${RAW_KEY}`) as `0x${string}`
  : generatePrivateKey();
const IS_EPHEMERAL = !RAW_KEY;

const TIMEOUT_MS = 60_000;
const JSON_FLAG = flags.includes("--json");

if (!command || flags.includes("--help") || command === "-h") {
  console.log(`
  clawq — CLI gateway for the Teneo Agent Network

  COMMANDS
    discover                        Full JSON manifest of everything: agents, commands,
                                    pricing, payment networks. Feed this to your AI agent.
    agents                          List all public agents (table or JSON)
    agents --search <keyword>       Search agents by name/description
    agents --online                 Show only online agents
    agents --free                   Show only agents with free commands
    info <agent-id>                 Show agent details, commands, and pricing
    query "<message>"               Send a query via WebSocket
                                      Direct:    "@agent-id command args"
                                      Freeform:  "find me a hotel in Vienna"

  FLAGS
    --json                          Machine-readable JSON output (all commands)
    --private-key <key>             Wallet private key (64 hex chars)
    --online                        Filter: online agents only
    --free                          Filter: agents with free commands
    --search <keyword>              Filter: search by keyword

  AUTHENTICATION (pick one)
    clawq --private-key <key> query "..."      Inline
    PRIVATE_KEY=<key> clawq query "..."        Environment variable
    echo "PRIVATE_KEY=<key>" > .env            .env file (auto-loaded)

  EXAMPLES
    clawq discover
    clawq discover | jq '.command_index[] | select(.is_free)'
    clawq agents --online --json
    clawq info hotel-finder --json
    clawq --private-key abc123 query "@hotel-finder help"

  ENVIRONMENT
    PRIVATE_KEY   Wallet private key (64 hex chars, no 0x prefix).
                  If not set, an ephemeral wallet is generated automatically.
    BACKEND_URL   Backend URL (default: ${BACKEND_URL})
  `);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

interface AgentCommand {
  trigger: string;
  description: string;
  argument?: string;
  parameters?: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    isBillingCount?: boolean;
    minValue?: string;
  }>;
  pricePerUnit?: number;
  priceType?: string;
  taskUnit?: string;
  timeUnit?: string;
  minArgs?: number;
  maxArgs?: number;
}

interface Agent {
  agent_id: string;
  agent_name: string;
  description?: string;
  agent_type?: string;
  is_online: boolean;
  is_verified: boolean;
  review_status: string;
  capabilities?: string;
  commands?: string | AgentCommand[];
  nft_id?: number;
  creator?: string;
  categories?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// REST Fetchers
// ═══════════════════════════════════════════════════════════════════

async function fetchAgents(): Promise<Agent[]> {
  const agents: Agent[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const res = await fetch(`${BACKEND_URL}/api/public/agents?limit=${limit}&offset=${offset}`);
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const batch = data.agents || [];
    agents.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  return agents;
}

async function fetchNetworks(): Promise<any> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/networks`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function fetchFeeConfig(): Promise<any> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/fee-config`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function parseCommands(agent: Agent): AgentCommand[] {
  if (!agent.commands) return [];
  if (Array.isArray(agent.commands)) return agent.commands;
  try {
    return JSON.parse(agent.commands as string);
  } catch {
    return [];
  }
}

function formatPrice(cmd: AgentCommand): string {
  if (!cmd.pricePerUnit || cmd.pricePerUnit === 0) return "FREE";
  const unit = cmd.taskUnit === "per-item" ? "/item" : "/query";
  return `$${cmd.pricePerUnit} USDC${unit}`;
}

function normalizeAgent(agent: Agent) {
  const commands = parseCommands(agent);
  return {
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    description: agent.description || "",
    agent_type: agent.agent_type || "command",
    is_online: agent.is_online,
    review_status: agent.review_status,
    nft_id: agent.nft_id || null,
    creator: agent.creator || null,
    commands: commands.map(c => ({
      trigger: c.trigger,
      description: c.description,
      usage: `@${agent.agent_id} ${c.trigger}${c.argument ? " " + c.argument : ""}`,
      price: c.pricePerUnit || 0,
      price_type: c.priceType || "task-transaction",
      task_unit: c.taskUnit || "per-query",
      time_unit: c.timeUnit || null,
      is_free: !c.pricePerUnit || c.pricePerUnit === 0,
      min_args: c.minArgs ?? 0,
      max_args: c.maxArgs ?? 0,
      parameters: (c.parameters || []).map(p => ({
        name: p.name,
        type: p.type,
        required: p.required,
        description: p.description,
        is_billing_count: p.isBillingCount || false,
      })),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Command: discover — Complete JSON manifest for AI agents
// ═══════════════════════════════════════════════════════════════════

async function cmdDiscover() {
  const [agents, networks, feeConfig] = await Promise.all([
    fetchAgents(),
    fetchNetworks(),
    fetchFeeConfig(),
  ]);

  const onlineAgents = agents.filter(a => a.is_online);
  const normalized = agents.map(normalizeAgent);
  const onlineNormalized = onlineAgents.map(normalizeAgent);

  // Build a flat command index: every callable command across all online agents
  const commandIndex: any[] = [];
  for (const agent of onlineNormalized) {
    for (const cmd of agent.commands) {
      commandIndex.push({
        usage: cmd.usage,
        agent_id: agent.agent_id,
        agent_name: agent.agent_name,
        trigger: cmd.trigger,
        description: cmd.description,
        price: cmd.price,
        is_free: cmd.is_free,
        task_unit: cmd.task_unit,
        parameters: cmd.parameters,
      });
    }
  }

  const manifest = {
    _meta: {
      generated_at: new Date().toISOString(),
      backend: BACKEND_URL,
      websocket: WS_URL,
      total_agents: agents.length,
      online_agents: onlineAgents.length,
      total_commands: commandIndex.length,
      note: "Use 'query' command to execute. Direct: @agent-id trigger args. Freeform: any natural language query.",
    },
    how_to_query: {
      direct_command: '@<agent_id> <trigger> <args>',
      freeform: '<any natural language question> (coordinator auto-selects the best agent)',
      example_direct: '@hotel-finder search vienna luxury',
      example_freeform: 'find me a boutique hotel in Prague',
      execution: 'clawq query "<message>"',
    },
    agents: normalized,
    online_agents: onlineNormalized,
    command_index: commandIndex,
    networks: networks,
    fee_config: feeConfig,
  };

  console.log(JSON.stringify(manifest, null, 2));
}

// ═══════════════════════════════════════════════════════════════════
// Command: agents — List agents
// ═══════════════════════════════════════════════════════════════════

async function cmdAgents() {
  const searchFlag = flags.find(f => f === "--search");
  const searchIdx = process.argv.indexOf("--search");
  const searchTerm = searchIdx !== -1 ? process.argv[searchIdx + 1]?.toLowerCase() : null;
  const onlyOnline = flags.includes("--online");
  const onlyFree = flags.includes("--free");

  let agents = await fetchAgents();

  if (searchTerm) {
    agents = agents.filter(a =>
      a.agent_id.toLowerCase().includes(searchTerm) ||
      a.agent_name.toLowerCase().includes(searchTerm) ||
      (a.description || "").toLowerCase().includes(searchTerm)
    );
  }
  if (onlyOnline) agents = agents.filter(a => a.is_online);
  if (onlyFree) {
    agents = agents.filter(a => {
      const cmds = parseCommands(a);
      return cmds.some(c => !c.pricePerUnit || c.pricePerUnit === 0);
    });
  }

  // JSON output
  if (JSON_FLAG) {
    console.log(JSON.stringify(agents.map(normalizeAgent), null, 2));
    return;
  }

  // Table output
  if (agents.length === 0) {
    console.log("No agents found matching your criteria.");
    return;
  }

  console.log("");
  const col = { id: 24, name: 28, status: 8, type: 10, cmds: 6, price: 14 };
  console.log(
    pad("AGENT ID", col.id) + pad("NAME", col.name) + pad("STATUS", col.status) +
    pad("TYPE", col.type) + pad("CMDS", col.cmds) + pad("PRICE RANGE", col.price)
  );
  console.log("─".repeat(col.id + col.name + col.status + col.type + col.cmds + col.price));

  for (const agent of agents) {
    const cmds = parseCommands(agent);
    const prices = cmds.map(c => c.pricePerUnit || 0);
    const minP = Math.min(...(prices.length ? prices : [0]));
    const maxP = Math.max(...(prices.length ? prices : [0]));
    let priceRange: string;
    if (maxP === 0) priceRange = "FREE";
    else if (minP === 0) priceRange = `FREE-$${maxP}`;
    else if (minP === maxP) priceRange = `$${minP}`;
    else priceRange = `$${minP}-$${maxP}`;

    const status = agent.is_online ? "\x1b[32mON\x1b[0m    " : "\x1b[31mOFF\x1b[0m   ";
    console.log(
      pad(agent.agent_id, col.id) + pad(agent.agent_name, col.name) + status +
      pad(agent.agent_type || "command", col.type) + pad(String(cmds.length), col.cmds) + priceRange
    );
  }

  console.log(`\n${agents.length} agent(s) found.`);
}

// ═══════════════════════════════════════════════════════════════════
// Command: info — Agent details
// ═══════════════════════════════════════════════════════════════════

async function cmdInfo() {
  const agentId = rest[0];
  if (!agentId) {
    console.error("Usage: clawq info <agent-id>");
    process.exit(1);
  }

  const agents = await fetchAgents();
  const agent = agents.find(a => a.agent_id === agentId);

  if (!agent) {
    const similar = agents.filter(a =>
      a.agent_id.includes(agentId) || a.agent_name.toLowerCase().includes(agentId.toLowerCase())
    );
    if (JSON_FLAG) {
      console.log(JSON.stringify({ error: "not_found", agent_id: agentId, suggestions: similar.slice(0, 5).map(a => a.agent_id) }));
    } else {
      console.error(`Agent "${agentId}" not found.`);
      if (similar.length > 0) {
        console.log("\nDid you mean:");
        similar.slice(0, 5).forEach(a => console.log(`  ${a.agent_id}  (${a.agent_name})`));
      }
    }
    process.exit(1);
  }

  // JSON output
  if (JSON_FLAG) {
    console.log(JSON.stringify(normalizeAgent(agent), null, 2));
    return;
  }

  // Pretty output
  const cmds = parseCommands(agent);

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(`║  ${padCenter(agent.agent_name, 52)}║`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  ID:          ${agent.agent_id}`);
  console.log(`  Type:        ${agent.agent_type || "command"}`);
  console.log(`  Status:      ${agent.is_online ? "\x1b[32mONLINE\x1b[0m" : "\x1b[31mOFFLINE\x1b[0m"}`);
  console.log(`  Visibility:  ${agent.review_status}`);
  if (agent.nft_id) console.log(`  NFT Token:   #${agent.nft_id}`);
  if (agent.creator) console.log(`  Creator:     ${agent.creator}`);
  if (agent.description) console.log(`  Description: ${agent.description}`);

  if (cmds.length > 0) {
    console.log(`\n  COMMANDS (${cmds.length}):`);
    console.log("  " + "─".repeat(60));

    for (const cmd of cmds) {
      const price = formatPrice(cmd);
      const cmdArgs = cmd.argument || (cmd.minArgs === 0 ? "" : "<args>");
      console.log(`\n  @${agent.agent_id} ${cmd.trigger}${cmdArgs ? " " + cmdArgs : ""}`);
      console.log(`    ${cmd.description}`);
      console.log(`    Price: ${price}  |  Args: ${cmd.minArgs ?? 0}-${cmd.maxArgs ?? 0}`);

      if (cmd.parameters && cmd.parameters.length > 0) {
        console.log("    Parameters:");
        for (const p of cmd.parameters) {
          const billing = p.isBillingCount ? " [billing count]" : "";
          const req = p.required ? "required" : "optional";
          console.log(`      ${p.name} (${p.type}, ${req})${billing} — ${p.description}`);
        }
      }
    }
  }

  const paidCmds = cmds.filter(c => c.pricePerUnit && c.pricePerUnit > 0);
  if (paidCmds.length > 0) {
    console.log("\n  BILLING EXAMPLES:");
    console.log("  " + "─".repeat(60));
    for (const cmd of paidCmds) {
      if (cmd.taskUnit === "per-item") {
        const billingParam = cmd.parameters?.find(p => p.isBillingCount);
        const paramName = billingParam?.name || "count";
        console.log(`    @${agent.agent_id} ${cmd.trigger} ... ${paramName}=10`);
        console.log(`      → ${cmd.pricePerUnit} x 10 = $${(cmd.pricePerUnit! * 10).toFixed(4)} USDC`);
      } else {
        console.log(`    @${agent.agent_id} ${cmd.trigger}`);
        console.log(`      → $${cmd.pricePerUnit} USDC per query`);
      }
    }
  }

  console.log(`\n  QUERY THIS AGENT:`);
  console.log(`    clawq query "@${agent.agent_id} ${cmds[0]?.trigger || "help"}"\n`);
}

// ═══════════════════════════════════════════════════════════════════
// Command: query — WebSocket authenticated query
// ═══════════════════════════════════════════════════════════════════

async function cmdQuery() {
  const message = rest.join(" ");
  if (!message) {
    console.error("Usage: clawq query \"@agent-id command args\"");
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY);

  if (!JSON_FLAG) {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║           clawq — Query               ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`  Wallet:  ${account.address}${IS_EPHEMERAL ? " (ephemeral)" : ""}`);
    console.log(`  Server:  ${WS_URL}`);
    console.log(`  Query:   ${message}`);
    if (IS_EPHEMERAL) {
      console.log("\n  Note: Using ephemeral wallet. Agents may not be in your room.");
      console.log("  Set PRIVATE_KEY env var for a persistent wallet with agent access.");
    }
    console.log("");
  }

  let privateRoomId: string | null = null;
  let responseReceived = false;

  const ws = new WebSocket(WS_URL);

  const timeout = setTimeout(() => {
    if (!responseReceived) {
      if (JSON_FLAG) console.log(JSON.stringify({ error: "timeout", message: "No response after 60s" }));
      else console.log("\n  Timed out after 60s waiting for response.");
      ws.close();
      process.exit(1);
    }
  }, TIMEOUT_MS);

  function done(code = 0) {
    clearTimeout(timeout);
    setTimeout(() => { ws.close(); process.exit(code); }, 500);
  }

  ws.on("open", () => {
    if (!JSON_FLAG) console.log("[1/4] Connected. Requesting challenge...");
    ws.send(JSON.stringify({
      type: "request_challenge",
      data: { userType: "user", address: account.address }
    }));
  });

  ws.on("message", async (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());

    // ─── Challenge → Sign → Auth ──────────────────────────────
    if (msg.type === "challenge") {
      const challenge = msg.data?.challenge;
      const text = `Teneo authentication challenge: ${challenge}`;
      const signature = await account.signMessage({ message: text });

      if (!JSON_FLAG) console.log("[2/4] Challenge received. Signing...");
      ws.send(JSON.stringify({
        type: "auth",
        data: { address: account.address, message: text, signature, userType: "user" }
      }));
    }

    // ─── Authenticated → Extract room → Send query ────────────
    if (msg.type === "auth" || msg.type === "authenticated" || msg.type === "success") {
      const privateRooms = msg.data?.private_rooms || [];
      if (privateRooms.length > 0) privateRoomId = privateRooms[0].id;
      if (!privateRoomId) {
        const roomObjs = msg.data?.room_objects || [];
        const priv = roomObjs.find((r: any) => !r.is_public);
        if (priv) privateRoomId = priv.id;
      }
      if (!privateRoomId) {
        const rooms = msg.data?.rooms || [];
        if (rooms.length > 0) privateRoomId = typeof rooms[0] === "string" ? rooms[0] : rooms[0].id;
      }

      if (!privateRoomId) {
        if (JSON_FLAG) console.log(JSON.stringify({ error: "no_room", message: "No room available" }));
        else console.error("  No room available. Cannot send query.");
        done(1);
        return;
      }

      if (!JSON_FLAG) {
        console.log(`[3/4] Authenticated. Room: ${privateRoomId}`);
        console.log(`[4/4] Sending: "${message}"\n`);
        console.log("Waiting for response...\n");
      }

      ws.send(JSON.stringify({ type: "message", content: message, room: privateRoomId }));
    }

    // ─── Coordinator selected an agent ────────────────────────
    if (msg.type === "agent_selected") {
      const name = msg.data?.agent_name || msg.content?.agent_name || "unknown";
      const reason = msg.data?.reasoning || msg.content?.reasoning || "";
      if (!JSON_FLAG) console.log(`  Coordinator → ${name}${reason ? ` (${reason})` : ""}`);
    }

    // ─── Agent response ───────────────────────────────────────
    if (msg.type === "task_response") {
      responseReceived = true;
      const from = msg.from || msg.data?.agent_name || "Agent";
      const content = msg.content || msg.data?.content || "";

      if (JSON_FLAG) {
        console.log(JSON.stringify({ type: "response", from, content, data: msg.data || null }));
      } else {
        console.log("═══════════════════════════════════════════════════════");
        console.log(`  RESPONSE from ${from}:`);
        console.log("═══════════════════════════════════════════════════════");
        printContent(content);
        console.log("═══════════════════════════════════════════════════════\n");
      }
      done(0);
    }

    // ─── Message-type response (some agents use this) ─────────
    if (msg.type === "message" && msg.from && msg.from !== "system" && msg.from.toLowerCase() !== account.address.toLowerCase()) {
      responseReceived = true;
      if (JSON_FLAG) {
        console.log(JSON.stringify({ type: "response", from: msg.from, content: msg.content }));
      } else {
        console.log("═══════════════════════════════════════════════════════");
        console.log(`  RESPONSE from ${msg.from}:`);
        console.log("═══════════════════════════════════════════════════════");
        printContent(msg.content);
        console.log("═══════════════════════════════════════════════════════\n");
      }
      done(0);
    }

    // ─── System message (ignore echoes) ───────────────────────
    if (msg.type === "message" && msg.from === "system" && !JSON_FLAG) {
      console.log(`  [system] ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`);
    }

    // ─── Quote (paid agent) ───────────────────────────────────
    if (msg.type === "task_quote") {
      const q = msg.data || {};
      const price = q.pricing?.price_per_unit ?? q.pricing?.pricePerUnit ?? 0;
      const taskUnit = q.pricing?.task_unit ?? q.pricing?.taskUnit ?? "per-query";
      const isFree = price === 0 || q.payment_required === false;

      if (isFree) {
        // Auto-confirm free task quotes — get the actual agent response
        if (!JSON_FLAG) {
          console.log(`  Quote from ${q.agent_name || q.agent_id} (FREE) — auto-confirming...`);
        }
        ws.send(JSON.stringify({
          type: "confirm_task",
          data: { task_id: q.task_id },
          room: privateRoomId,
        }));
        // Don't mark as done — wait for the actual task_response
      } else if (!IS_EPHEMERAL) {
        // Paid quote + real key → sign payment and auto-confirm
        if (!JSON_FLAG) {
          console.log(`  Quote from ${q.agent_name || q.agent_id}: ${price} USDC (${taskUnit})`);
          console.log("  Signing x402 payment...");
        }

        try {
          const paymentHeader = await signPayment(PRIVATE_KEY, q);
          if (!JSON_FLAG) console.log("  Payment signed. Confirming task...");

          ws.send(JSON.stringify({
            type: "confirm_task",
            data: { task_id: q.task_id },
            room: privateRoomId,
            payment: paymentHeader,
          }));
          // Wait for task_response
        } catch (err: any) {
          responseReceived = true;
          if (JSON_FLAG) {
            console.log(JSON.stringify({ type: "payment_error", task_id: q.task_id, error: err.message, quote: q }));
          } else {
            console.error(`  Payment signing failed: ${err.message}`);
            console.log("  You may need USDC on the payment network to complete this query.");
          }
          done(1);
        }
      } else {
        // Paid quote + ephemeral key → can't pay, show quote details
        responseReceived = true;
        if (JSON_FLAG) {
          console.log(JSON.stringify({
            type: "task_quote",
            agent_id: q.agent_id,
            agent_name: q.agent_name,
            task_id: q.task_id,
            price, task_unit: taskUnit,
            network: q.network || null,
            agent_wallet: q.agent_wallet || null,
            settlement_router: q.settlement_router || null,
            expires_at: q.expires_at || null,
            raw: q,
          }));
        } else {
          console.log("═══════════════════════════════════════════════════════");
          console.log("  PAYMENT REQUIRED — set PRIVATE_KEY to auto-pay");
          console.log("═══════════════════════════════════════════════════════");
          console.log(`  Agent:      ${q.agent_name || q.agent_id}`);
          console.log(`  Price:      ${price} USDC (${taskUnit})`);
          console.log(`  Network:    ${q.network || "?"}`);
          console.log(`  Pay To:     ${q.agent_wallet || "?"}`);
          console.log("───────────────────────────────────────────────────────");
          console.log("  Set PRIVATE_KEY env var with a funded wallet to");
          console.log("  auto-sign and pay for this query.");
          console.log("═══════════════════════════════════════════════════════\n");
        }
        done(0);
      }
    }

    // ─── Agents list (arrives after auth) ─────────────────────
    if (msg.type === "agents" && !JSON_FLAG) {
      const list = Array.isArray(msg.data) ? msg.data : msg.data?.agents || msg.content || [];
      if (Array.isArray(list) && list.length > 0) {
        const online = list.filter((a: any) => a.is_online).length;
        console.log(`  [${list.length} agents in network, ${online} online]`);
      }
    }

    // ─── Error ────────────────────────────────────────────────
    if (msg.type === "error") {
      const code = msg.data?.code || "";
      const errMsg = msg.content || msg.data?.message || "Unknown error";
      if (JSON_FLAG) console.log(JSON.stringify({ type: "error", code, message: errMsg }));
      else console.error(`  ERROR (${code}): ${errMsg}`);
    }

    // ─── Rate limit ───────────────────────────────────────────
    if (msg.type === "rate_limit_notification") {
      if (JSON_FLAG) console.log(JSON.stringify({ type: "rate_limit", message: msg.content || msg.data?.message }));
      else console.log(`  RATE LIMITED: ${msg.content || msg.data?.message || "Too many requests"}`);
    }
  });

  ws.on("error", (err) => {
    if (JSON_FLAG) console.log(JSON.stringify({ type: "error", message: err.message }));
    else console.error("WebSocket error:", err.message);
    done(1);
  });

  ws.on("close", (code, reason) => {
    if (!responseReceived && !JSON_FLAG) {
      console.log(`Disconnected (${code}: ${reason.toString() || "normal"})`);
    }
    clearTimeout(timeout);
  });
}

// ═══════════════════════════════════════════════════════════════════
// x402 Payment Signing (ERC-3009 TransferWithAuthorization)
// ═══════════════════════════════════════════════════════════════════

interface NetworkConfig {
  chainId: number;
  name: string;
  caip2: string;
  rpcUrl: string;
  usdcContract: string;
  settlementRouter: string;
  transferHook: string;
  eip712: { name: string; version: string };
}

let networkCache: Record<string, NetworkConfig> | null = null;

async function fetchNetworkConfig(networkName: string): Promise<NetworkConfig> {
  if (!networkCache) {
    const res = await fetch(`${BACKEND_URL}/api/networks`);
    if (!res.ok) throw new Error(`Failed to fetch networks: ${res.status}`);
    const data = await res.json();
    networkCache = data.networks || {};
  }
  // Try exact match, then CAIP-2 match
  if (networkCache![networkName]) return networkCache![networkName];
  for (const [, cfg] of Object.entries(networkCache!)) {
    if (cfg.caip2 === networkName || cfg.caip2 === `eip155:${networkName}`) return cfg;
  }
  // Default to peaq
  if (networkCache!["peaq"]) return networkCache!["peaq"];
  throw new Error(`Unknown network: ${networkName}. Available: ${Object.keys(networkCache!).join(", ")}`);
}

const ERC3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

async function signPayment(
  privateKey: `0x${string}`,
  quoteData: any,
): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const network = await fetchNetworkConfig(quoteData.network || "peaq");
  const chain = defineChain({
    id: network.chainId,
    name: network.name,
    network: network.name.toLowerCase().replace(/\s+/g, "-"),
    nativeCurrency: { decimals: 18, name: "Native", symbol: "NATIVE" },
    rpcUrls: { default: { http: [network.rpcUrl] }, public: { http: [network.rpcUrl] } },
  });

  const pricePerUnit = quoteData.pricing?.price_per_unit ?? quoteData.pricing?.pricePerUnit ?? 0;
  const amountMicroUnits = Math.round(pricePerUnit * 1e6);
  const amountStr = amountMicroUnits.toString();
  const recipientAddress = quoteData.agent_wallet;
  const asset = network.usdcContract;
  const settlementRouter = quoteData.settlement_router || network.settlementRouter;
  const salt = (quoteData.salt || toHex(crypto.getRandomValues(new Uint8Array(32)))) as Hex;
  const facilitatorFee = quoteData.facilitator_fee || "100";
  const hook = (quoteData.hook || network.transferHook) as Hex;
  const hookData = (quoteData.hook_data || "0x") as Hex;

  const totalValueStr = (BigInt(amountStr) + BigInt(facilitatorFee)).toString();

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + 60;

  const commitment = keccak256(
    encodePacked(
      ["string", "uint256", "address", "address", "address", "uint256", "uint256", "uint256", "bytes32", "address", "uint256", "address", "bytes32"],
      [
        "X402/settle/v1",
        BigInt(chain.id),
        settlementRouter as Hex,
        asset as Hex,
        account.address,
        BigInt(totalValueStr),
        BigInt(validAfter),
        BigInt(validBefore),
        salt,
        recipientAddress as Hex,
        BigInt(facilitatorFee),
        hook,
        keccak256(hookData),
      ],
    ),
  );

  const domain = {
    name: network.eip712.name,
    version: network.eip712.version,
    chainId: BigInt(chain.id),
    verifyingContract: asset as `0x${string}`,
  };

  const message = {
    from: account.address,
    to: settlementRouter as `0x${string}`,
    value: BigInt(totalValueStr),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: commitment,
  };

  const signature = await signTypedData({
    privateKey,
    domain,
    types: ERC3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  const facilitatorFeeHex = `0x${BigInt(facilitatorFee).toString(16)}`;
  const resourceUrl = BACKEND_URL + "/x402";

  const v2Payload = {
    x402Version: 2,
    resource: { url: resourceUrl, description: "clawq payment", mimeType: "application/json" },
    accepted: {
      scheme: "exact",
      network: network.caip2,
      amount: amountStr,
      asset,
      payTo: recipientAddress,
      maxTimeoutSeconds: 60,
      extra: {
        name: network.eip712.name,
        version: network.eip712.version,
        settlementRouter,
        salt,
        payTo: recipientAddress,
        facilitatorFee: facilitatorFeeHex,
        hook,
        hookData,
      },
    },
    payload: {
      authorization: {
        from: account.address,
        to: settlementRouter,
        value: totalValueStr,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce: commitment,
      },
      signature,
    },
    extensions: {
      "x402x-router-settlement": {
        info: {
          settlementRouter,
          hook,
          hookData,
          facilitatorFee: facilitatorFeeHex,
          salt,
          finalPayTo: recipientAddress,
        },
      },
    },
  };

  return Buffer.from(JSON.stringify(v2Payload)).toString("base64");
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function pad(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len - 1) + " " : str + " ".repeat(len - str.length);
}

function padCenter(str: string, len: number): string {
  if (str.length >= len) return str.substring(0, len);
  const left = Math.floor((len - str.length) / 2);
  const right = len - str.length - left;
  return " ".repeat(left) + str + " ".repeat(right);
}

function printContent(content: any) {
  if (typeof content === "string") console.log(content);
  else if (content?.content_type && content?.content) {
    console.log(`  [${content.content_type}]`);
    if (typeof content.content === "string") console.log(content.content);
    else console.log(JSON.stringify(content.content, null, 2));
  } else {
    console.log(JSON.stringify(content, null, 2));
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main router
// ═══════════════════════════════════════════════════════════════════

async function main() {
  switch (command) {
    case "discover": await cmdDiscover(); break;
    case "agents":   await cmdAgents(); break;
    case "info":     await cmdInfo(); break;
    case "query":    await cmdQuery(); break;
    default:
      console.error(`Unknown command: "${command}". Run with --help for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
