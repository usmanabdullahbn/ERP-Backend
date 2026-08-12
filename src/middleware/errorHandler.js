const errorHandler = (err, req, res, next) => {
  console.error('[error]', err);

  if (err.name === 'ValidationError') {
    const fieldErrors = Object.fromEntries(
      Object.entries(err.errors || {}).map(([field, e]) => [field, e.message])
    );
    return res.status(400).json({ message: err.message, errors: fieldErrors });
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0];
    return res.status(409).json({ message: `Duplicate value for field: ${field}` });
  }

  const status = err.statusCode || 500;
  res.status(status).json({ message: err.message || 'Internal server error' });
};

module.exports = errorHandler;
