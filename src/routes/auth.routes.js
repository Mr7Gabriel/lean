const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { User } = require('../db/models');
const config = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * @route   POST /api/setup
 * @desc    Setup initial admin user
 * @access  Public
 */
router.post('/setup', [
  // Validation
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
    
    // Check if email already exists
    const existingEmail = await User.findOne({ where: { email } });
    if (existingEmail) {
      return res.status(400).json({
        status: 'error',
        message: 'Email sudah terdaftar'
      });
    }
    
    // Check if username already exists
    const existingUsername = await User.findOne({ where: { username } });
    if (existingUsername) {
      return res.status(400).json({
        status: 'error',
        message: 'Username sudah terdaftar'
      });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const user = await User.create({
      username,
      email,
      hashedPassword,
      role: 'admin'  // First user is admin
    });
    
    return res.status(201).json({
      status: 'success',
      message: 'User berhasil dibuat',
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/login
 * @desc    Login to get JWT token
 * @access  Public
 */
router.post('/login', [
  // Validation
  body('email').isEmail().withMessage('Email tidak valid'),
  body('password').notEmpty().withMessage('Password tidak boleh kosong')
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
    
    const { email, password } = req.body;
    
    // Validate input not empty
    if (!email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'Email dan password tidak boleh kosong'
      });
    }
    
    // Check if user exists
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(400).json({
        status: 'error',
        message: 'Email tidak terdaftar'
      });
    }
    
    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.hashedPassword);
    if (!isPasswordValid) {
      return res.status(400).json({
        status: 'error',
        message: 'Password salah'
      });
    }
    
    // Create JWT token
    const token = jwt.sign(
      { sub: user.username, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );
    
    return res.json({
      access_token: token,
      token_type: 'bearer'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;