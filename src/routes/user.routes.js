const express = require('express');
const { body, param, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const { User } = require('../db/models');
const { authenticateJWT, isAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * @route   GET /api/user
 * @desc    Get all users (admin only)
 * @access  Private/Admin
 */
router.get('/user', [authenticateJWT, isAdmin], async (req, res, next) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'username', 'email', 'role', 'createdAt', 'updatedAt']
    });
    
    return res.json(users);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/user/me
 * @desc    Get current user info
 * @access  Private
 */
router.get('/user/me', authenticateJWT, async (req, res, next) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'username', 'email', 'role', 'createdAt', 'updatedAt']
    });
    
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User tidak ditemukan'
      });
    }
    
    return res.json(user);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/user/:id
 * @desc    Get user by ID (admin only)
 * @access  Private/Admin
 */
router.get('/user/:id', [
  authenticateJWT,
  isAdmin,
  param('id').isInt().withMessage('ID harus berupa angka')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    const user = await User.findByPk(req.params.id, {
      attributes: ['id', 'username', 'email', 'role', 'createdAt', 'updatedAt']
    });
    
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User tidak ditemukan'
      });
    }
    
    return res.json(user);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/user
 * @desc    Create new user (admin only)
 * @access  Private/Admin
 */
router.post('/user', [
  authenticateJWT,
  isAdmin,
  body('username').notEmpty().withMessage('Username tidak boleh kosong'),
  body('email').isEmail().withMessage('Email tidak valid'),
  body('password').isLength({ min: 8 }).withMessage('Password minimal 8 karakter')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    const { username, email, password } = req.body;
    
    // Check if username already exists
    const existingUsername = await User.findOne({ where: { username } });
    if (existingUsername) {
      return res.status(400).json({
        status: 'error',
        message: 'Username sudah terdaftar'
      });
    }
    
    // Check if email already exists
    const existingEmail = await User.findOne({ where: { email } });
    if (existingEmail) {
      return res.status(400).json({
        status: 'error',
        message: 'Email sudah terdaftar'
      });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const user = await User.create({
      username,
      email,
      hashedPassword,
      role: 'author'  // Default role for new users
    });
    
    return res.status(201).json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/user/:id
 * @desc    Update user (admin only)
 * @access  Private/Admin
 */
router.put('/user/:id', [
  authenticateJWT,
  isAdmin,
  param('id').isInt().withMessage('ID harus berupa angka'),
  body('username').optional().notEmpty().withMessage('Username tidak boleh kosong'),
  body('email').optional().isEmail().withMessage('Email tidak valid'),
  body('password').optional().isLength({ min: 8 }).withMessage('Password minimal 8 karakter')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    const { username, email, password } = req.body;
    const userId = req.params.id;
    
    // Get user
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User tidak ditemukan'
      });
    }
    
    // Check if username already exists (if changed)
    if (username && username !== user.username) {
      const existingUsername = await User.findOne({ where: { username } });
      if (existingUsername) {
        return res.status(400).json({
          status: 'error',
          message: 'Username sudah terdaftar'
        });
      }
    }
    
    // Check if email already exists (if changed)
    if (email && email !== user.email) {
      const existingEmail = await User.findOne({ where: { email } });
      if (existingEmail) {
        return res.status(400).json({
          status: 'error',
          message: 'Email sudah terdaftar'
        });
      }
    }
    
    // Update user
    if (username) user.username = username;
    if (email) user.email = email;
    
    // Update password if provided
    if (password) {
      user.hashedPassword = await bcrypt.hash(password, 10);
    }
    
    await user.save();
    
    return res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/user/:id
 * @desc    Delete user (admin only)
 * @access  Private/Admin
 */
router.delete('/user/:id', [
  authenticateJWT,
  isAdmin,
  param('id').isInt().withMessage('ID harus berupa angka')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    const userId = req.params.id;
    
    // Get user
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User tidak ditemukan'
      });
    }
    
    // Prevent deleting self
    if (user.id === req.user.id) {
      return res.status(400).json({
        status: 'error',
        message: 'Tidak dapat menghapus diri sendiri'
      });
    }
    
    // Delete user
    await user.destroy();
    
    return res.json({
      status: 'success',
      message: 'User berhasil di hapus'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/user/wp-credentials
 * @desc    Set WordPress API credentials
 * @access  Private
 */
router.post('/user/wp-credentials', [
  authenticateJWT,
  body('api_username').notEmpty().withMessage('API username tidak boleh kosong'),
  body('api_password').notEmpty().withMessage('API password tidak boleh kosong')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    const { api_username, api_password } = req.body;
    
    // Get user
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User tidak ditemukan'
      });
    }
    
    // Update credentials
    user.apiUsername = api_username;
    user.apiPassword = api_password;
    
    await user.save();
    
    return res.json({
      status: 'success',
      message: 'WordPress API credentials berhasil disimpan'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;