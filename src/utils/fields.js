function numberValue(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return 0;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return NaN;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

module.exports = { numberValue };
