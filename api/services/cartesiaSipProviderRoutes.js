'use strict';

function sendError(ctx, req, res, status, code, message) {
  if (typeof ctx.sendApiError === 'function') return ctx.sendApiError(res, status, code, message, req.requestId || null);
  return res.status(status).json({ success: false, code, error: message, request_id: req.requestId || null });
}

function registerCartesiaSipProviderRoutes(app, ctx = {}) {
  const limiter = typeof ctx.cartesiaApprovalLimiter === 'function' ? ctx.cartesiaApprovalLimiter : (_req, _res, next) => next();
  const authorize = typeof ctx.requireOutboundAuthorization === 'function' ? ctx.requireOutboundAuthorization : (_req, _res, next) => next();
  const actor = typeof ctx.requireCallEActorAssertion === 'function' ? ctx.requireCallEActorAssertion : (_req, _res, next) => next();
  const root = '/api/cartesia/providers';

  const handle = (method, status = 200) => async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== 'function' || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendError(ctx, req, res, 403, 'cartesia_admin_required', 'Cartesia provider management is restricted to administrators');
      }
      const service = typeof ctx.createCartesiaSipProviderService === 'function' ? ctx.createCartesiaSipProviderService() : null;
      if (!service) return sendError(ctx, req, res, 503, 'cartesia_provider_unavailable', 'Cartesia provider management is unavailable');
      const result = await method(service, req);
      return res.status(status).json({ success: true, ...(result || {}) });
    } catch (error) {
      const code = String(error?.code || 'cartesia_provider_operation_failed');
      const mappedStatus = Number(error?.status) || (code.includes('invalid') || code.includes('required') || code.includes('confirmation') ? 400 : code.includes('not_configured') ? 503 : code.includes('not_found') ? 404 : 502);
      // Never log request bodies or provider responses: they may contain credentials.
      console.error('cartesia_provider_route_error', { code, status: mappedStatus });
      return sendError(ctx, req, res, mappedStatus, code, mappedStatus >= 500 ? 'Cartesia provider operation failed' : error.message);
    }
  };

  app.get(root, limiter, authorize, actor, handle((service) => service.listProviders()));
  app.post(root, limiter, authorize, actor, handle((service, req) => {
    const type = String(req.body?.type || '').trim();
    const label = String(req.body?.label || '').trim().toUpperCase();
    const expected = `CREATE CARTESIA ${type.toUpperCase()} PROVIDER ${label}`;
    if (!label || !['twilio', 'sip_trunk'].includes(type) || req.body?.confirmation_phrase !== expected) {
      throw Object.assign(new Error('An exact provider creation confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return service.createProvider(req.body || {});
  }, 201));
  app.patch(`${root}/:providerId`, limiter, authorize, actor, handle((service, req) => {
    const providerId = String(req.params?.providerId || '');
    if (req.body?.confirmation_phrase !== `UPDATE CARTESIA PROVIDER ${providerId}`) {
      throw Object.assign(new Error('An exact provider update confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return service.updateProvider(providerId, req.body || {});
  }));
  app.delete(`${root}/:providerId`, limiter, authorize, actor, handle((service, req) => {
    const providerId = String(req.params?.providerId || '');
    if (req.body?.confirmation_phrase !== `DELETE CARTESIA PROVIDER ${providerId}`) {
      throw Object.assign(new Error('An exact provider deletion confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return service.deleteProvider(providerId);
  }));
}

module.exports = { registerCartesiaSipProviderRoutes };
