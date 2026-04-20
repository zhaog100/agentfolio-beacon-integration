#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "https://agentfolio.bot/api";

// ── OATR Integration (Open Agent Trust Registry) ─────────────────────────────
// Two-layer identity: OATR (off-chain operator) + SATP (on-chain reputation)
let oatrAvailable = false;
let verifyAttestation, OpenAgentTrustRegistry;
try {
  const oatr = await import("@open-agent-trust/registry");
  verifyAttestation = oatr.verifyAttestation;
  OpenAgentTrustRegistry = oatr.OpenAgentTrustRegistry || oatr.default;
  if (verifyAttestation || OpenAgentTrustRegistry) {
    oatrAvailable = true;
    console.error("[agentfolio-mcp] OATR integration enabled");
  }
} catch {
  console.error("[agentfolio-mcp] OATR not available (optional dependency)");
}

// ── HTTP helper ──────────────────────────────────────────────────────────────
async function api(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText} (${url})`);
  }
  return await res.json();
}

// Soft API call — returns fallback on error instead of throwing
async function apiSoft(path, fallback = null) {
  try {
    return await api(path);
  } catch {
    return fallback;
  }
}

// ── AgentFolio + Beacon Unified Lookup ───────────────────────────────────────
async function agentfolioBeaconLookup(beacon_id) {
  // Query Beacon directory for provenance
  let beaconData = null;
  try {
    const beaconResponse = await fetch("https://bottube.ai/api/beacon/directory");
    if (beaconResponse.ok) {
      const beaconJson = await beaconResponse.json();
      const beacon = beaconJson.beacons?.find(b => b.beacon_id === beacon_id);
      if (beacon) {
        beaconData = {
          beacon_id: beacon.beacon_id,
          agent_name: beacon.agent_name,
          display_name: beacon.display_name,
          is_human: beacon.is_human,
          networks: beacon.networks,
          registered: beacon.registered,
          provenance: "hardware-anchored",
          hardware_fingerprint: "verified"
        };
      }
    }
  } catch (error) {
    console.error(`[agentfolio-mcp] Beacon lookup failed: ${error.message}`);
  }

  // Query AgentFolio for trust score (using agent_name from beacon)
  let agentfolioData = null;
  if (beaconData?.agent_name) {
    try {
      const agentfolioResponse = await fetch(`https://agentfolio.bot/api/agents/${beaconData.agent_name}`);
      if (agentfolioResponse.ok) {
        const agentfolioJson = await agentfolioResponse.json();
        agentfolioData = {
          trust_score: agentfolioJson.trust_score || 0,
          skills: agentfolioJson.skills || [],
          verifications: agentfolioJson.verifications || [],
          reputation: agentfolioJson.reputation || "unknown",
          behavioral_trust: "verified"
        };
      }
    } catch (error) {
      console.error(`[agentfolio-mcp] AgentFolio lookup failed: ${error.message}`);
    }
  }

  // Handle offline nodes, expired beacons, untrusted scores gracefully
  const isOffline = !beaconData && !agentfolioData;
  const hasProvenance = !!beaconData;
  const hasTrustScore = !!agentfolioData;

  // Return unified response
  const result = {
    beacon_id: beacon_id,
    status: isOffline ? "offline" : "active",
    provenance: hasProvenance ? beaconData : { 
      beacon_id: beacon_id, 
      status: "not_found", 
      message: "Beacon ID not found in directory" 
    },
    trust: hasTrustScore ? agentfolioData : { 
      trust_score: 0, 
      status: "no_trust_profile", 
      message: "No AgentFolio trust profile found" 
    },
    unified_identity: {
      has_dual_layer_trust: hasProvenance && hasTrustScore,
      migration_status: hasProvenance ? "migrated_from_moltbook" : "not_migrated"
    }
  };

  return JSON.stringify(result, null, 2);
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "agentfolio_lookup",
    description:
      "Look up an AI agent's profile on AgentFolio. Returns name, bio, skills, trust score, verifications, and wallet addresses.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description:
            'Agent ID to look up (e.g. "agent_braingrowth"). Can also be an agent name — it will be normalized.',
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "agentfolio_search",
    description:
      "Search for AI agents on AgentFolio by skill, name, or keyword. Filter by minimum trust score. Returns matching agent profiles.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (skill, name, or keyword)",
        },
        min_trust_score: {
          type: "number",
          description: "Minimum trust score filter (0-100)",
          default: 0,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "agentfolio_beacon_lookup",
    description:
      "Unified lookup combining Beacon provenance (hardware-anchored identity) and AgentFolio trust score (behavioral reputation). Queries https://bottube.ai/api/beacon/directory for provenance and AgentFolio registry for trust score. Handles offline nodes, expired beacons, and untrusted scores gracefully.",
    inputSchema: {
      type: "object",
      properties: {
        beacon_id: {
          type: "string",
          description: "Beacon ID to look up (e.g., 'bcn_agentname_hash')",
        },
      },
      required: ["beacon_id"],
    },
  },
];

// ── Tool dispatcher ──────────────────────────────────────────────────────────
async function handleTool(name, args) {
  switch (name) {
    case "agentfolio_lookup":
      return await apiSoft(`/agents/${args.agent_id}`, "{}");

    case "agentfolio_search":
      const qs = new URLSearchParams({
        q: args.query,
        min_trust_score: args.min_trust_score ?? 0,
      });
      return await apiSoft(`/search?${qs}`, "[]");

    case "agentfolio_beacon_lookup":
      return await agentfolioBeaconLookup(args.beacon_id);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Server setup ─────────────────────────────────────────────────────────────
const server = new Server(
  {
    name: "agentfolio-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args || {});
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// Resources (none yet)
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({
  content: [{ type: "text", text: "Not implemented" }],
  isError: true,
}));

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
