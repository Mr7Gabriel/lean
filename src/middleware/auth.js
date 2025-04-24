const jwt = require('jsonwebtoken');
const { User } = require('../db/models');
const config = require('../config');

/**
 * Verify JWT token middleware
 */
exports.authenticateJWT = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        status: 'error',
        message: 'Token tidak ada'
      });
    }
    
    const token = authHeader.split(' ')[1];
    
    // Verify token
    const decoded = jwt.verify(token, config.jwt.secret);
    
    // Find user
    const user = await User.findOne({ where: { username: decoded.sub } });
    
    if (!user) {
      return res.status(401).json({
        status: 'error',
        message: 'User tidak ditemukan'
      });
    }
    
    // Attach user to request object
    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        status: 'error',
        message: 'Token expired'
      });
    }
    
    return res.status(401).json({
      status: 'error',
      message: 'Token tidak valid'
    });
  }
};

/**
 * Check if user has admin role
 */
exports.isAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized'
    });
  }
  
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      status: 'error',
      message: 'Tidak memiliki hak akses'
    });
  }
  
  next();
};