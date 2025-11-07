function normalizeModel(model) {
  return typeof model === 'string' ? model.trim().toLowerCase() : '';
}

module.exports = function checkPrice(args = {}) {
  const model = normalizeModel(args.model);

  let price = 149;

  if (model === 'airpods pro') {
    price = 249;
  } else if (model === 'airpods max') {
    price = 549;
  }

  return JSON.stringify({ price });
};
