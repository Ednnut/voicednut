"use strict";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const NAME_PATTERN = /^[^\r\n\u0000-\u001f]{1,120}$/;

function serviceError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function requireId(value, kind) {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id)) throw serviceError(`cartesia_${kind}_id_invalid`, `A valid Cartesia ${kind} ID is required`);
  return id;
}

function safeName(value, kind) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!NAME_PATTERN.test(name)) throw serviceError(`cartesia_${kind}_name_invalid`, `A ${kind} name of 1–120 characters is required`);
  return name;
}

function safeMetadata(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 20) {
    throw serviceError("cartesia_knowledge_base_metadata_invalid", "Metadata must be an object with no more than 20 fields");
  }
  const metadata = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key) || !["string", "number", "boolean"].includes(typeof entry) ||
        (typeof entry === "string" && entry.length > 200) || (typeof entry === "number" && !Number.isFinite(entry))) {
      throw serviceError("cartesia_knowledge_base_metadata_invalid", "Metadata fields must have safe keys and short scalar values");
    }
    metadata[key] = entry;
  }
  return metadata;
}

function listRows(value, keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function safeFolder(row = {}) {
  const id = String(row.id || "").trim();
  if (!ID_PATTERN.test(id)) return null;
  return {
    id,
    name: String(row.name || "").slice(0, 120),
    parentId: ID_PATTERN.test(String(row.parent_id || "")) ? String(row.parent_id) : null,
    documentCount: Math.max(0, Number(row.document_count) || 0),
    agentIds: listRows(row, ["agents"]).map((agent) => String(agent?.id || "")).filter((agentId) => ID_PATTERN.test(agentId)).slice(0, 100),
    createdAt: typeof row.created_at === "string" ? row.created_at.slice(0, 40) : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at.slice(0, 40) : null,
  };
}

function safeDocument(row = {}) {
  const id = String(row.id || "").trim();
  if (!ID_PATTERN.test(id)) return null;
  return {
    id,
    name: String(row.name || "").slice(0, 120),
    folderId: ID_PATTERN.test(String(row.folder_id || "")) ? String(row.folder_id) : null,
    status: String(row.status || "unknown").slice(0, 32),
    contentLength: typeof row.content === "string" ? row.content.length : Math.max(0, Number(row.content_length) || 0),
    metadata: safeMetadata(row.metadata || {}) || {},
    createdAt: typeof row.created_at === "string" ? row.created_at.slice(0, 40) : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at.slice(0, 40) : null,
  };
}

class CartesiaKnowledgeBaseService {
  constructor(options = {}) { this.client = options.client; }

  async listFolders(query = {}) {
    const result = await this.client.listFolders({ limit: Math.max(1, Math.min(100, Number(query.limit) || 50)), startingAfter: query.starting_after });
    return { folders: listRows(result, ["data", "folders"]).map(safeFolder).filter(Boolean) };
  }
  async getFolder(id) {
    const row = await this.client.getFolder(requireId(id, "folder"));
    const folder = safeFolder(row.folder || row);
    if (!folder) throw serviceError("cartesia_knowledge_base_folder_invalid", "Cartesia returned an invalid folder", 502);
    return { folder };
  }
  async createFolder(input = {}) {
    const name = safeName(input.name, "folder");
    const parentId = input.parent_id ? requireId(input.parent_id, "folder") : undefined;
    const row = await this.client.createFolder({ name, ...(parentId ? { parent_id: parentId } : {}) });
    const folder = safeFolder(row.folder || row);
    if (!folder) throw serviceError("cartesia_knowledge_base_folder_invalid", "Cartesia returned an invalid folder", 502);
    return { folder };
  }
  async updateFolder(id, input = {}) {
    const folderId = requireId(id, "folder");
    const body = {};
    if (input.name !== undefined) body.name = safeName(input.name, "folder");
    if (input.parent_id !== undefined) body.parent_id = input.parent_id === null ? null : requireId(input.parent_id, "folder");
    if (input.agents !== undefined) {
      if (!Array.isArray(input.agents) || input.agents.length > 100) throw serviceError("cartesia_knowledge_base_agents_invalid", "Provide no more than 100 agent IDs");
      body.agents = input.agents.map((entry) => ({ id: requireId(entry?.id, "agent") }));
    }
    if (!Object.keys(body).length) throw serviceError("cartesia_knowledge_base_update_empty", "Provide a folder name, parent, or agent assignment");
    const row = await this.client.updateFolder(folderId, body);
    const folder = safeFolder(row.folder || row);
    return { folder: folder || { id: folderId, updated: true } };
  }
  async assignFolderAgents(id, agentIds) {
    const agents = Array.isArray(agentIds) ? agentIds : [];
    return this.updateFolder(id, { agents: agents.map((agentId) => ({ id: agentId })) });
  }
  async deleteFolder(id) {
    const folderId = requireId(id, "folder");
    await this.client.deleteFolder(folderId);
    return { deleted: true, folderId };
  }

  async listDocuments(query = {}) {
    const folderId = query.folder_id ? requireId(query.folder_id, "folder") : undefined;
    const result = await this.client.listDocuments({ folderId, limit: Math.max(1, Math.min(100, Number(query.limit) || 50)), startingAfter: query.starting_after });
    return { documents: listRows(result, ["data", "documents"]).map(safeDocument).filter(Boolean) };
  }
  async getDocument(id) {
    const row = await this.client.getDocument(requireId(id, "document"));
    const document = safeDocument(row.document || row);
    if (!document) throw serviceError("cartesia_knowledge_base_document_invalid", "Cartesia returned an invalid document", 502);
    return { document };
  }
  async createDocument(input = {}) {
    const name = safeName(input.name, "document");
    const folderId = requireId(input.folder_id, "folder");
    const content = typeof input.content === "string" ? input.content : "";
    if (!content.trim() || content.length > 65536) throw serviceError("cartesia_knowledge_base_content_invalid", "Document content must contain 1–65,536 characters");
    const metadata = safeMetadata(input.metadata);
    const row = await this.client.createDocument({ name, folder_id: folderId, content, ...(metadata ? { metadata } : {}) });
    const document = safeDocument(row.document || row);
    if (!document) throw serviceError("cartesia_knowledge_base_document_invalid", "Cartesia returned an invalid document", 502);
    return { document };
  }
  async createDocumentsBulk(input = {}) {
    const entries = Array.isArray(input.documents) ? input.documents : [];
    if (!entries.length || entries.length > 100) throw serviceError("cartesia_knowledge_base_documents_invalid", "Bulk document creation requires 1–100 documents");
    const documents = entries.map((entry) => {
      const name = safeName(entry?.name, "document");
      const folderId = requireId(entry?.folder_id, "folder");
      const content = typeof entry?.content === "string" ? entry.content : "";
      if (!content.trim() || content.length > 65536) throw serviceError("cartesia_knowledge_base_content_invalid", "Every document must contain 1–65,536 characters");
      const metadata = safeMetadata(entry?.metadata);
      return { name, folder_id: folderId, content, ...(metadata ? { metadata } : {}) };
    });
    const result = await this.client.createDocumentsBulk({ documents });
    const rows = listRows(result, ["data", "documents"]);
    return { documents: rows.map(safeDocument).filter(Boolean), acceptedCount: rows.length };
  }
  async updateDocument(id, input = {}) {
    const documentId = requireId(id, "document");
    const body = {};
    if (input.name !== undefined) body.name = safeName(input.name, "document");
    if (input.folder_id !== undefined) body.folder_id = requireId(input.folder_id, "folder");
    if (input.content !== undefined) {
      if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 65536) throw serviceError("cartesia_knowledge_base_content_invalid", "Document content must contain 1–65,536 characters");
      body.content = input.content;
    }
    if (input.metadata !== undefined) body.metadata = safeMetadata(input.metadata);
    if (!Object.keys(body).length) throw serviceError("cartesia_knowledge_base_update_empty", "Provide a document name, folder, content, or metadata");
    const row = await this.client.updateDocument(documentId, body);
    const document = safeDocument(row.document || row);
    return { document: document || { id: documentId, updated: true } };
  }
  async deleteDocument(id) {
    const documentId = requireId(id, "document");
    await this.client.deleteDocument(documentId);
    return { deleted: true, documentId };
  }
}

module.exports = { CartesiaKnowledgeBaseService, safeFolder, safeDocument, safeMetadata };
