export function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status ?? err.statusCode ?? 500;
  res.status(status).json({
    error: err.name || 'Error',
    message: err.message || 'Internal server error',
  });
}
