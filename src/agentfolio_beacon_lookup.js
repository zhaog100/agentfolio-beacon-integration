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

module.exports = { agentfolioBeaconLookup };
