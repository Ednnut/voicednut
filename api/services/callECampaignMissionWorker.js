"use strict";

const crypto = require("node:crypto");

const MISSION_ID_PATTERN = /^mission_[a-f0-9]{64}$/;
const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ACTOR_ID_PATTERN = /^\d{1,20}$/;
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const SAFE_STATES = new Set([
  "call_accepted", "waiting_for_call", "waiting_for_result", "recovery_required",
  "needs_review", "completed", "canceled", "error",
  "paused",
]);

function safeErrorCode(error) {
  const code = String(error?.code || "").trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "call_e_mission_worker_failed";
}

function normalizeState(value) {
  const state = String(value || "").trim().toLowerCase();
  if (state === "complete") return "completed";
  return SAFE_STATES.has(state) ? state : "error";
}

function validateConfig(config = {}) {
  return config.enabled === true &&
    MISSION_ID_PATTERN.test(String(config.missionId || "").trim()) &&
    BUSINESS_ID_PATTERN.test(String(config.businessId || "").trim()) &&
    ACTOR_ID_PATTERN.test(String(config.actorId || "").trim()) &&
    WORKER_ID_PATTERN.test(String(config.workerId || "").trim());
}

class CallECampaignMissionWorker {
  constructor(options = {}) {
    this.config = options.config || {};
    this.db = options.db || null;
    this.createMissionService = options.createMissionService;
    this.intervalMs = Math.max(1000, Math.min(900000, Number(this.config.intervalMs) || 60000));
    this.leaseMs = Math.max(60000, Math.min(300000, this.intervalMs * 3));
    this.setInterval = options.setIntervalFn || setInterval;
    this.clearInterval = options.clearIntervalFn || clearInterval;
    this.randomBytes = options.randomBytesFn || crypto.randomBytes;
    this.timer = null;
    this.inflight = null;
  }

  isConfigured() {
    return validateConfig(this.config) &&
      typeof this.createMissionService === "function" &&
      typeof this.db?.acquireCallECampaignMissionWorkerLease === "function" &&
      typeof this.db?.releaseCallECampaignMissionWorkerLease === "function" &&
      typeof this.db?.getCallECampaignMissionWorkerControl === "function";
  }

  async drain() {
    if (this.config.enabled !== true) return { state: "disabled", provider_requests: 0 };
    if (!this.isConfigured()) return { state: "not_configured", provider_requests: 0 };
    if (this.inflight) return { state: "already_running", provider_requests: 0 };

    const missionId = String(this.config.missionId).trim();
    const businessId = String(this.config.businessId).trim();
    const actorId = String(this.config.actorId).trim();
    const workerId = String(this.config.workerId).trim();
    const leaseToken = this.randomBytes(24).toString("hex");

    this.inflight = (async () => {
      let acquired = false;
      let heartbeat = null;
      let outcome = { state: "error", provider_requests: 0, error_code: null };
      try {
        const control = await this.db.getCallECampaignMissionWorkerControl(missionId, businessId);
        if (control?.paused) return { state: "paused", provider_requests: 0 };
        acquired = await this.db.acquireCallECampaignMissionWorkerLease({
          mission_id: missionId,
          business_id: businessId,
          worker_id: workerId,
          lease_token: leaseToken,
          lease_ms: this.leaseMs,
        });
        if (!acquired) return { state: "lease_busy", provider_requests: 0 };

        const service = await this.createMissionService();
        if (!service || typeof service.advance !== "function") {
          throw Object.assign(new Error("CALL-E mission service is unavailable"), { code: "call_e_mission_unavailable" });
        }
        if (typeof this.db.renewCallECampaignMissionWorkerLease === "function") {
          heartbeat = this.setInterval(() => {
            void this.db.renewCallECampaignMissionWorkerLease({
              mission_id: missionId, business_id: businessId, worker_id: workerId,
              lease_token: leaseToken, lease_ms: this.leaseMs,
            }).catch(() => {});
          }, Math.max(1000, Math.floor(this.leaseMs / 3)));
          heartbeat?.unref?.();
        }
        const result = await service.advance({
          mission_id: missionId,
          business_id: businessId,
          actor_id: actorId,
          source: "worker",
        });
        outcome = {
          state: normalizeState(result?.state || result?.mission?.status),
          provider_requests: Number(result?.provider_requests) === 1 ? 1 : 0,
          error_code: null,
        };
      } catch (error) {
        outcome = { state: "error", provider_requests: 0, error_code: safeErrorCode(error) };
      } finally {
        if (heartbeat) this.clearInterval(heartbeat);
        if (acquired) {
          try {
            await this.db.releaseCallECampaignMissionWorkerLease({
              mission_id: missionId,
              business_id: businessId,
              worker_id: workerId,
              lease_token: leaseToken,
              state: outcome.state,
              error_code: outcome.error_code,
            });
          } catch (_) {
            outcome = { state: "error", provider_requests: outcome.provider_requests, error_code: "call_e_mission_lease_release_failed" };
          }
        }
      }
      return outcome;
    })();

    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  start() {
    if (this.timer) return true;
    if (!this.isConfigured()) return false;
    this.timer = this.setInterval(() => { void this.drain(); }, this.intervalMs);
    this.timer?.unref?.();
    void this.drain();
    return true;
  }

  async stop() {
    if (this.timer) {
      this.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight;
  }
}

module.exports = { CallECampaignMissionWorker, validateConfig, safeErrorCode, normalizeState };
