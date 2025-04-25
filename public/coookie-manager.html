const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateJWT, isAdmin } = require('../middleware/auth');
const cookieHelper = require('../utils/cookieHelper');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * @route   GET /api/cookies/:domain
 * @desc    Get cookies for a domain
 * @access  Private/Admin
 */
router.get('/:domain', [
  authenticateJWT,
  isAdmin,
  param('domain').notEmpty().withMessage('Domain tidak boleh kosong')
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
    
    const { domain } = req.params;
    
    // Get cookies
    const cookies = cookieHelper.getCookiesForDomain(domain);
    
    return res.json({
      status: 'success',
      data: cookies
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/cookies/:domain
 * @desc    Save cookies for a domain
 * @access  Private/Admin
 */
router.post('/:domain', [
  authenticateJWT,
  isAdmin,
  param('domain').notEmpty().withMessage('Domain tidak boleh kosong'),
  body('cookies').isArray().withMessage('Cookies harus berupa array')
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
    
    const { domain } = req.params;
    let { cookies } = req.body;
    
    // Format cookies if needed
    if (cookies.length > 0 && cookies[0].Domain) {
      // This looks like cookies from browser dev tools export
      cookies = cookieHelper.formatBrowserCookies(cookies);
    }
    
    // Save cookies
    const success = cookieHelper.saveCookiesForDomain(domain, cookies);
    
    if (success) {
      return res.json({
        status: 'success',
        message: `Berhasil menyimpan ${cookies.length} cookies untuk domain ${domain}`
      });
    } else {
      return res.status(500).json({
        status: 'error',
        message: 'Gagal menyimpan cookies'
      });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;