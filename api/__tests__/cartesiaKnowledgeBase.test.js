"use strict";

const assert = require("node:assert/strict");
const { CartesiaKnowledgeBaseClient, API_VERSION } = require("../services/cartesiaKnowledgeBaseClient");
const { CartesiaKnowledgeBaseService } = require("../services/cartesiaKnowledgeBaseService");
const { contentFingerprint, registerCartesiaKnowledgeBaseRoutes } = require("../services/cartesiaKnowledgeBaseRoutes");

describe("Cartesia Knowledge Base", () => {
  it("uses the documented versioned endpoints and server-side credentials", async () => {
    const requests = [];
    const client = new CartesiaKnowledgeBaseClient({ enabled: true, apiKey: "server-key", fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return { ok: true, status: 200, json: async () => ({ id: "folder_1", name: "Help" }) };
    } });
    await client.createFolder({ name: "Help" });
    await client.createDocument({ name: "FAQ", folder_id: "folder_1", content: "Private source" });
    await client.updateFolder("folder_1", { agents: [{ id: "agent_1" }] });
    await client.deleteDocument("document_1");
    assert.deepEqual(requests.map(({ url, options }) => [options.method, url.pathname]), [
      ["POST", "/agents/folders"], ["POST", "/agents/documents"], ["PATCH", "/agents/folders/folder_1"], ["DELETE", "/agents/documents/document_1"],
    ]);
    assert.ok(requests.every(({ options }) => options.headers.Authorization === "Bearer server-key"));
    assert.ok(requests.every(({ options }) => options.headers["Cartesia-Version"] === API_VERSION));
    assert.deepEqual(JSON.parse(requests[2].options.body), { agents: [{ id: "agent_1" }] });
  });

  it("returns document metadata without returning provider content", async () => {
    const client = {
      async createDocument(input) {
        assert.equal(input.content, "private text");
        return { id: "document_1", name: input.name, folder_id: input.folder_id, status: "indexed", content: input.content, metadata: { source: "admin" } };
      },
      async getDocument() { return { id: "document_1", name: "FAQ", folder_id: "folder_1", content: "private text", status: "indexed" }; },
    };
    const service = new CartesiaKnowledgeBaseService({ client });
    const created = await service.createDocument({ name: "FAQ", folder_id: "folder_1", content: "private text" });
    const loaded = await service.getDocument("document_1");
    assert.equal(created.document.contentLength, 12);
    assert.equal(loaded.document.contentLength, 12);
    assert.equal(Object.hasOwn(created.document, "content"), false);
    assert.equal(JSON.stringify([created, loaded]).includes("private text"), false);
  });

  it("supports bounded bulk document creation without echoing document text", async () => {
    let submitted;
    const service = new CartesiaKnowledgeBaseService({ client: {
      async createDocumentsBulk(input) { submitted = input; return { data: input.documents.map((row, index) => ({ id: `doc_${index}`, name: row.name, folder_id: row.folder_id, content: row.content, status: "indexed" })) }; },
    } });
    const result = await service.createDocumentsBulk({ documents: [{ name: "FAQ", folder_id: "folder_1", content: "private content" }] });
    assert.equal(submitted.documents.length, 1);
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.documents[0].contentLength, 15);
    assert.doesNotMatch(JSON.stringify(result), /private content/);
    await assert.rejects(service.createDocumentsBulk({ documents: [] }), { code: "cartesia_knowledge_base_documents_invalid" });
  });

  it("validates bounds and folder-agent assignments before provider writes", async () => {
    let calls = 0;
    const service = new CartesiaKnowledgeBaseService({ client: {
      async updateFolder(id, input) { calls += 1; return { id, name: "Help", agents: input.agents }; },
      async createDocument() { calls += 1; return { id: "document_1", name: "FAQ", folder_id: "folder_1" }; },
    } });
    await assert.rejects(service.createDocument({ name: "FAQ", folder_id: "folder_1", content: " " }), { code: "cartesia_knowledge_base_content_invalid" });
    await assert.rejects(service.createDocument({ name: "FAQ", folder_id: "folder_1", content: "x".repeat(65537) }), { code: "cartesia_knowledge_base_content_invalid" });
    await assert.rejects(service.assignFolderAgents("folder_1", Array(101).fill("agent_1")), { code: "cartesia_knowledge_base_agents_invalid" });
    assert.equal(calls, 0);
    const assigned = await service.assignFolderAgents("folder_1", ["agent_1"]);
    assert.deepEqual(assigned.folder.agentIds, ["agent_1"]);
  });

  it("requires admin authorization and exact confirmation before any mutation", async () => {
    const routes = new Map();
    const app = Object.fromEntries(["get", "post", "patch", "put", "delete"].map((verb) => [verb, (path, ...handlers) => routes.set(`${verb.toUpperCase()} ${path}`, handlers)]));
    let writes = 0;
    registerCartesiaKnowledgeBaseRoutes(app, {
      cartesiaApprovalLimiter: (_req, _res, next) => next(),
      requireOutboundAuthorization: (_req, _res, next) => next(),
      requireCallEActorAssertion: (_req, _res, next) => next(),
      async isCartesiaAdminActor(actorId) { return actorId === "7001"; },
      createCartesiaKnowledgeBaseService: () => ({ async createFolder() { writes += 1; return { folder: { id: "folder_1", name: "Help" } }; } }),
    });
    const route = routes.get("POST /api/cartesia/knowledge-base/folders").at(-1);
    const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
    const req = (actor, phrase) => ({ callEActorId: actor, body: { name: "Help", confirmation_phrase: phrase } });
    const deniedAdmin = response();
    await route(req("7002", "CREATE CARTESIA KB FOLDER HELP"), deniedAdmin);
    assert.equal(deniedAdmin.statusCode, 403);
    const deniedConfirmation = response();
    await route(req("7001", "CREATE FOLDER HELP"), deniedConfirmation);
    assert.equal(deniedConfirmation.statusCode, 400);
    assert.equal(writes, 0);
    const accepted = response();
    await route(req("7001", "CREATE CARTESIA KB FOLDER HELP"), accepted);
    assert.equal(accepted.statusCode, 201);
    assert.equal(writes, 1);
    assert.equal(JSON.stringify(accepted.body).includes("content"), false);
  });

  it("binds document write confirmation to the exact private content", async () => {
    const routes = new Map();
    const app = Object.fromEntries(["get", "post", "patch", "put", "delete"].map((verb) => [verb, (path, ...handlers) => routes.set(path, handlers)]));
    let submittedContent = "";
    registerCartesiaKnowledgeBaseRoutes(app, {
      cartesiaApprovalLimiter: (_req, _res, next) => next(),
      requireOutboundAuthorization: (_req, _res, next) => next(),
      requireCallEActorAssertion: (_req, _res, next) => next(),
      async isCartesiaAdminActor(actorId) { return actorId === "7001"; },
      createCartesiaKnowledgeBaseService: () => ({
        async createDocument(input) { submittedContent = input.content; return { document: { id: "doc_1" } }; },
      }),
    });
    const route = routes.get("/api/cartesia/knowledge-base/documents").at(-1);
    const makeResponse = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
    const body = { name: "FAQ", folder_id: "folder_1", content: "approved text" };
    const req = (content, phrase) => ({ callEActorId: "7001", body: { ...body, content, confirmation_phrase: phrase } });
    const stalePhrase = `CREATE CARTESIA KB DOCUMENT FAQ IN FOLDER folder_1 CONTENT SHA256 ${contentFingerprint(body.content)}`;
    const changed = makeResponse();
    await route(req("changed text", stalePhrase), changed);
    assert.equal(changed.statusCode, 400);
    assert.equal(submittedContent, "");
    const accepted = makeResponse();
    await route(req(body.content, stalePhrase), accepted);
    assert.equal(accepted.statusCode, 201);
    assert.equal(submittedContent, body.content);
    assert.doesNotMatch(JSON.stringify(accepted.body), /approved text/);
  });
});
