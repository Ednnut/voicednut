"use strict";

const fetch = require("node-fetch");

const API_BASE_URL = "https://api.cartesia.ai";
const API_VERSION = "2026-08-14";
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

function clientError(code, message, status = null) {
  return Object.assign(new Error(message), { code, status: Number(status) || null });
}

function pathId(value, kind) {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id)) throw clientError(`cartesia_${kind}_id_invalid`, `A valid Cartesia ${kind} ID is required`, 400);
  return encodeURIComponent(id);
}

class CartesiaKnowledgeBaseClient {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || "").trim();
    this.enabled = options.enabled === true;
    this.timeoutMs = Math.max(1000, Math.min(60000, Number(options.timeoutMs) || 20000));
    this.fetch = options.fetch || fetch;
    this.apiBaseUrl = String(options.apiBaseUrl || API_BASE_URL).replace(/\/+$/, "");
    this.apiVersion = String(options.apiVersion || API_VERSION);
  }

  async request(method, path, body, operation) {
    if (!this.enabled || !this.apiKey || this.apiVersion !== API_VERSION || typeof this.fetch !== "function") {
      throw clientError("cartesia_knowledge_base_not_configured", "Cartesia Knowledge Base is disabled or not configured", 503);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetch(`${this.apiBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Cartesia-Version": this.apiVersion,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (response.status === 204) return {};
      const payload = await response.json().catch(() => {
        throw clientError(`cartesia_${operation}_response_invalid`, "Cartesia returned an invalid Knowledge Base response", response.status);
      });
      if (!response.ok) throw clientError(`cartesia_${operation}_failed`, "Cartesia rejected the Knowledge Base operation", response.status);
      return payload;
    } catch (error) {
      if (String(error?.code || "").startsWith("cartesia_")) throw error;
      throw clientError(`cartesia_${operation}_${error?.name === "AbortError" ? "timeout" : "transport_error"}`, "Cartesia Knowledge Base is temporarily unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  listFolders(query = {}) {
    const params = new URLSearchParams();
    if (query.limit) params.set("limit", String(Math.max(1, Math.min(100, Number(query.limit) || 50))));
    if (query.startingAfter) params.set("starting_after", pathId(query.startingAfter, "folder"));
    return this.request("GET", `/agents/folders${params.size ? `?${params}` : ""}`, undefined, "knowledge_base_folders_list");
  }
  getFolder(id) { return this.request("GET", `/agents/folders/${pathId(id, "folder")}`, undefined, "knowledge_base_folder_get"); }
  createFolder(input) { return this.request("POST", "/agents/folders", input, "knowledge_base_folder_create"); }
  updateFolder(id, input) { return this.request("PATCH", `/agents/folders/${pathId(id, "folder")}`, input, "knowledge_base_folder_update"); }
  deleteFolder(id) { return this.request("DELETE", `/agents/folders/${pathId(id, "folder")}`, undefined, "knowledge_base_folder_delete"); }

  listDocuments(query = {}) {
    const params = new URLSearchParams();
    if (query.folderId) params.set("folder_id", pathId(query.folderId, "folder"));
    if (query.limit) params.set("limit", String(Math.max(1, Math.min(100, Number(query.limit) || 50))));
    if (query.startingAfter) params.set("starting_after", pathId(query.startingAfter, "document"));
    return this.request("GET", `/agents/documents${params.size ? `?${params}` : ""}`, undefined, "knowledge_base_documents_list");
  }
  getDocument(id) { return this.request("GET", `/agents/documents/${pathId(id, "document")}`, undefined, "knowledge_base_document_get"); }
  createDocument(input) { return this.request("POST", "/agents/documents", input, "knowledge_base_document_create"); }
  createDocumentsBulk(input) { return this.request("POST", "/agents/documents/bulk", input, "knowledge_base_documents_bulk_create"); }
  updateDocument(id, input) { return this.request("PATCH", `/agents/documents/${pathId(id, "document")}`, input, "knowledge_base_document_update"); }
  deleteDocument(id) { return this.request("DELETE", `/agents/documents/${pathId(id, "document")}`, undefined, "knowledge_base_document_delete"); }
}

module.exports = { CartesiaKnowledgeBaseClient, API_VERSION };
