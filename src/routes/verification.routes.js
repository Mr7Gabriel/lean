const express = require('express');
const browserService = require('../services/browserService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * @route   GET /api/verify/:sessionId
 * @desc    Get verification session status
 * @access  Public
 */
router.get('/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({
        status: 'error',
        message: 'Session ID is required'
      });
    }
    
    const sessionStatus = await browserService.getVerificationSessionStatus(sessionId);
    
    return res.json({
      status: 'success',
      data: {
        ...sessionStatus,
        remoteViewUrl: `/api/verify/${sessionId}/view`  // Route for remote view
      }
    });
  } catch (error) {
    logger.error(`Error getting verification session: ${error.message}`);
    
    return res.status(404).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * @route   GET /api/verify/:sessionId/view
 * @desc    Get remote view of verification session
 * @access  Public
 */
router.get('/:sessionId/view', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({
        status: 'error',
        message: 'Session ID is required'
      });
    }
    
    // Get remote view data (screenshot)
    const remoteViewData = await browserService.getRemoteViewData(sessionId);
    
    // Return the screenshot data
    res.json({
      status: 'success',
      data: remoteViewData
    });
  } catch (error) {
    logger.error(`Error getting remote view: ${error.message}`);
    
    return res.status(404).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * @route   POST /api/verify/:sessionId/complete
 * @desc    Complete verification session
 * @access  Public
 */
router.post('/:sessionId/complete', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({
        status: 'error',
        message: 'Session ID is required'
      });
    }
    
    const result = await browserService.completeVerificationSession(sessionId);
    
    return res.json({
      status: 'success',
      message: result.message,
      data: {
        cookieCount: result.cookieCount,
        domain: result.domain
      }
    });
  } catch (error) {
    logger.error(`Error completing verification session: ${error.message}`);
    
    return res.status(400).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * @route   DELETE /api/verify/:sessionId
 * @desc    Cancel verification session
 * @access  Public
 */
router.delete('/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({
        status: 'error',
        message: 'Session ID is required'
      });
    }
    
    const result = await browserService.closeVerificationSession(sessionId);
    
    if (result) {
      return res.json({
        status: 'success',
        message: `Verification session ${sessionId} cancelled successfully`
      });
    } else {
      return res.status(404).json({
        status: 'error',
        message: `Verification session ${sessionId} not found`
      });
    }
  } catch (error) {
    logger.error(`Error cancelling verification session: ${error.message}`);
    
    return res.status(400).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * @route   POST /api/verify/:sessionId/remote-control
 * @desc    Handle remote control actions
 * @access  Public
 */
router.post('/:sessionId/remote-control', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { action, x, y, key, code, button, altKey, ctrlKey, shiftKey } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({
        status: 'error',
        message: 'Session ID is required'
      });
    }
    
    // Perform remote control action
    const result = await browserService.remoteControlAction(sessionId, {
      action,
      x,
      y,
      key,
      code,
      button,
      altKey,
      ctrlKey,
      shiftKey
    });
    
    return res.json({
      status: 'success',
      message: 'Remote action performed',
      data: result
    });
  } catch (error) {
    logger.error(`Error in remote control: ${error.message}`);
    
    return res.status(400).json({
      status: 'error',
      message: error.message
    });
  }
});

module.exports = router;