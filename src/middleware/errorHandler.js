const logger = require('../utils/logger');

/**
 * Global error handling middleware
 */
function errorHandler(err, req, res, next) {
  // Log the error
  logger.error(`${err.name}: ${err.message}`);
  if (err.stack) {
    logger.error(err.stack);
  }
  
  // Check if error is a validation error
  if (err.name === 'ValidationError' || (err.errors && Array.isArray(err.errors))) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation error',
      errors: err.errors || [err.message]
    });
  }
  
  // Check for Sequelize errors
  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    const errors = err.errors.map(e => e.message);
    return res.status(400).json({
      status: 'error',
      message: 'Database validation error',
      errors
    });
  }
  
  // Handle JWT errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid or expired token'
    });
  }
  
  // Default error response
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 
    ? 'Internal server error' 
    : err.message || 'Something went wrong';
  
  res.status(statusCode).json({
    status: 'error',
    message
  });
}

module.exports = errorHandler;