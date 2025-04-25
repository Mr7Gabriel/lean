const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticateJWT } = require('../middleware/auth');
const { User, Manga, Genre } = require('../db/models');
const { ScraperAdapter } = require('../services/scraperAdapter');
const WordPressClient = require('../services/wordpressClient');
const cdnService = require('../services/cdnService');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const scraperAdapter = new ScraperAdapter();

/**
 * @route   GET /api/manga
 * @desc    Scrape manga data from URL
 * @access  Private
 */
router.get('/manga', [
  authenticateJWT,
  query('url').isURL().withMessage('URL tidak valid')
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
    
    const { url } = req.query;
    
    // Validate URL
    if (!url) {
      return res.status(400).json({
        status: 'error',
        message: 'URL tidak boleh kosong'
      });
    }
    
    // Scrape manga data
    const result = await scraperAdapter.scrapeManga(url);
    
    // Return the result directly without additional processing
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/manga
 * @desc    Create new manga
 * @access  Private
 */
router.post('/manga', [
  authenticateJWT,
  body('title').notEmpty().withMessage('title tidak boleh kosong'),
  body('author').notEmpty().withMessage('author tidak boleh kosong'),
  body('genre').isArray().withMessage('genre harus berupa array'),
  body('status').isIn(['Ongoing', 'Completed', 'Hiatus']).withMessage('status tidak valid'),
  body('description').notEmpty().withMessage('description tidak boleh kosong'),
  body('thumbnail').notEmpty().withMessage('thumbnail tidak boleh kosong'),
  body('type').isIn(['Manga', 'Manhua', 'Manhwa', 'Comic', 'Novel']).withMessage('type tidak valid'),
  body('score').isFloat({ min: 0, max: 10 }).withMessage('score harus antara 0-10')
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
    
    const {
      title,
      title_alt,
      author,
      artist,
      genre,
      status,
      description,
      thumbnail,
      hot,
      project,
      score,
      type,
      serialization,
      published
    } = req.body;
    
    // Get user from database
    const user = await User.findByPk(req.user.id);
    
    // Check WordPress API credentials
    if (!user.apiUsername || !user.apiPassword) {
      return res.status(400).json({
        status: 'error',
        message: 'API credentials not found'
      });
    }
    
    // Create WordPress client
    const wpClient = new WordPressClient(user.apiUsername, user.apiPassword);
    
    // Get user info from WordPress
    const userInfo = await wpClient.getUserInfo();
    if (!userInfo.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Failed to get user info from WordPress'
      });
    }
    
    const wpUserId = userInfo.data.user.id;
    
    // Prepare WordPress manga data
    const wpManga = {
      post_title: title,
      post_content: description,
      ero_hot: hot || false,
      ero_project: project || false,
      ero_type: type,
      ero_status: status,
      id_author: wpUserId,
      ero_japanese: title_alt || '',
      ero_author: author,
      ero_artist: artist || '',
      ero_serialization: serialization || '',
      ero_published: published || '',
      ero_score: score.toString(),
      term_genre: genre
    };
    
    // Create manga in WordPress
    const wpResponse = await wpClient.createManga(wpManga);
    
    // Upload thumbnail/cover
    let thumbnailUrl = null;
    if (thumbnail) {
      try {
        // Check if thumbnail is URL or base64
        if (thumbnail.startsWith('http://') || thumbnail.startsWith('https://')) {
          // Download image from URL
          const response = await axios.get(thumbnail, { responseType: 'arraybuffer' });
          const imageData = Buffer.from(response.data);
          const mimeType = response.headers['content-type'] || 'image/jpeg';
          
          // Upload to WordPress
          const thumbnailResponse = await wpClient.uploadMedia(
            wpUserId,
            wpResponse.id,
            imageData,
            mimeType
          );
          
          thumbnailUrl = thumbnailResponse.data.url;
        } else {
          // Assume base64 encoded image
          // Extract mime type and data
          let mimeType = 'image/jpeg';  // Default
          let imageData;
          
          if (thumbnail.includes(',')) {
            const parts = thumbnail.split(',');
            const mimeMatch = parts[0].match(/data:(image\/[^;]+);/);
            if (mimeMatch) {
              mimeType = mimeMatch[1];
            }
            imageData = Buffer.from(parts[1], 'base64');
          } else {
            imageData = Buffer.from(thumbnail, 'base64');
          }
          
          // Upload to WordPress
          const thumbnailResponse = await wpClient.uploadMedia(
            wpUserId,
            wpResponse.id,
            imageData,
            mimeType
          );
          
          thumbnailUrl = thumbnailResponse.data.url;
        }
      } catch (error) {
        logger.error(`Error uploading thumbnail: ${error.message}`);
      }
    }
    
    // Create manga in local database
    const dbManga = await Manga.create({
      title,
      titleAlt: title_alt || null,
      author,
      artist: artist || null,
      status,
      description,
      thumbnailUrl,
      wpId: wpResponse.id,
      wpUrl: wpResponse.url,
      hot: hot || false,
      project: project || false,
      score,
      type,
      serialization: serialization || null,
      published: published || null,
      userId: req.user.id
    });
    
    // Add genres
    if (genre && Array.isArray(genre)) {
      for (const genreName of genre) {
        // Find or create genre
        const [genreObj] = await Genre.findOrCreate({
          where: { name: genreName }
        });
        
        // Add association
        await dbManga.addGenre(genreObj);
      }
    }
    
    return res.status(201).json({
      status: 'success',
      message: 'Postingan Berhasil di buat',
      data: {
        id: dbManga.id,
        wp_id: wpResponse.id,
        title: dbManga.title,
        url: wpResponse.url
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;