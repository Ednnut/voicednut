function normalizeModel(model) {
  return typeof model === 'string' ? model.trim().toLowerCase() : '';
}

module.exports = function checkInventory(args = {}) {
  const model = normalizeModel(args.model);

  let stock = 100;

  if (model === 'airpods pro') {
    stock = 10;
  } else if (model === 'airpods max') {
    stock = 0;
  }

  return JSON.stringify({ stock });
};
