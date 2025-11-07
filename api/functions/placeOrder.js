function normalizeModel(model) {
  return typeof model === 'string' ? model.trim().toLowerCase() : '';
}

const MODEL_PRICE = {
  'airpods pro': 249,
  'airpods max': 549
};

module.exports = function placeOrder(args = {}) {
  const model = normalizeModel(args.model);
  const quantity = Number(args.quantity) > 0 ? Number(args.quantity) : 1;

  const unitPrice = MODEL_PRICE[model] ?? 149;
  const price = unitPrice * quantity;

  const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;

  return JSON.stringify({
    orderNumber,
    price
  });
};
