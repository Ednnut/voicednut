'use strict';

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function text(value, max = 160) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function destinationsFromHandoff(tool) {
  return (Array.isArray(tool?.destinations) ? tool.destinations : []).slice(0, 20).map((destination) => {
    const type = text(destination?.type, 30) || 'unknown';
    const target = type === 'assistant'
      ? text(destination?.assistantName || destination?.assistantId, 160)
      : type === 'squad'
        ? text(`${destination?.squadId || 'squad'}${destination?.entryAssistantName ? ` / ${destination.entryAssistantName}` : ''}`, 160)
        : type === 'dynamic' ? 'dynamic' : 'unresolved';
    return {
      type,
      target: target || 'unresolved',
      description: text(destination?.description, 180),
    };
  });
}

function handoffsForMember(member = {}) {
  const routes = [];
  for (const destination of Array.isArray(member.assistantDestinations) ? member.assistantDestinations : []) {
    const single = destinationsFromHandoff({ destinations: [destination] })[0];
    if (single) routes.push(single);
  }
  const assistant = member.assistant && typeof member.assistant === 'object' ? member.assistant : {};
  const overrides = member.assistantOverrides && typeof member.assistantOverrides === 'object'
    ? member.assistantOverrides : {};
  const tools = [
    ...(Array.isArray(assistant?.model?.tools) ? assistant.model.tools : []),
    ...(Array.isArray(assistant.tools) ? assistant.tools : []),
    ...(Array.isArray(overrides.tools) ? overrides.tools : []),
    ...(Array.isArray(overrides['tools:append']) ? overrides['tools:append'] : []),
  ];
  for (const tool of tools) {
    if (String(tool?.type || '').toLowerCase() !== 'handoff') continue;
    routes.push(...destinationsFromHandoff(tool));
  }
  const seen = new Set();
  return routes.filter((route) => {
    const key = `${route.type}:${route.target}:${route.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
}

function summarizeMember(member = {}, index = 0) {
  const assistant = member.assistant && typeof member.assistant === 'object' ? member.assistant : {};
  return {
    position: index + 1,
    assistant_id: text(member.assistantId || assistant.id, 200) || null,
    assistant_name: text(member.assistantName || assistant.name || member.name, 120) || `Member ${index + 1}`,
    assistant_version: text(member.assistantVersion || assistant.latestVersion, 40) || 'latest',
    handoffs: handoffsForMember(member),
  };
}

function summarizeSquad(squad = {}) {
  const members = Array.isArray(squad.members) ? squad.members : [];
  const safeMembers = members.slice(0, 50).map(summarizeMember);
  return {
    id: text(squad.id, 200),
    name: text(squad.name, 120) || 'Unnamed squad',
    latest_version: text(squad.latestVersion, 40) || null,
    created_at: squad.createdAt || null,
    updated_at: squad.updatedAt || null,
    member_count: members.length,
    handoff_count: safeMembers.reduce((count, member) => count + member.handoffs.length, 0),
    members: safeMembers,
    truncated: members.length > safeMembers.length,
  };
}

class VapiSquadService {
  constructor(options = {}) {
    this.client = options.client;
  }

  assertConfigured() {
    if (!this.client?.isConfigured?.()) throw fail('vapi_not_configured', 'Vapi server credentials are not configured', 503);
  }

  async list(options = {}) {
    this.assertConfigured();
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 20)));
    const response = await this.client.listSquads({ limit });
    const squads = rowsFrom(response).slice(0, limit).map((squad) => summarizeSquad(squad)).filter((squad) => squad.id);
    return { limit, squads };
  }

  async get(squadId) {
    this.assertConfigured();
    const id = String(squadId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw fail('vapi_squad_id_invalid', 'A valid Vapi squad ID is required');
    const squad = await this.client.getSquad(id);
    if (String(squad?.id || '') !== id) throw fail('vapi_squad_not_found', 'Vapi squad was not found', 404);
    return summarizeSquad(squad);
  }
}

module.exports = { VapiSquadService, summarizeSquad, summarizeMember, handoffsForMember };
