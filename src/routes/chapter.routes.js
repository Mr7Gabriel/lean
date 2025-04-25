const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticateJWT } = require('../middleware/auth');
const { User, Manga, Chapter, ChapterImage } = require('../db/models');
const chapterService = require('../services/chapterService');
const cdnService = require('../services/cdnService');
const WordPressClient = require('../services/wordpressClient');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * @route   GET /api/chapter
 * @desc    Scrape chapter data from URL
 * @access  Private
 */
router.get('/chapter', [
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
    
    // Scrape chapter data
    const result = await chapterService.scrapeChapter(url);
    
    // Return the result directly without additional processing
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/chapter
 * @desc    Create new chapter
 * @access  Private
 */
router.post('/chapter', [
  authenticateJWT,
  body('id_manga').isInt().withMessage('id_manga harus berupa angka'),
  body('image_chapter').isArray().withMessage('image_chapter harus berupa array'),
  body('title').notEmpty().withMessage('title tidak boleh kosong'),
  body('chapter').notEmpty().withMessage('chapter tidak boleh kosong')
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
    
    const { id_manga, image_chapter, title, chapter } = req.body;
    
    // Validate required fields
    if (!id_manga) {
      return res.status(400).json({
        status: 'error',
        message: 'id_manga tidak boleh kosong'
      });
    }
    
    if (!image_chapter || image_chapter.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'image_chapter tidak boleh kosong'
      });
    }
    
    if (!title) {
      return res.status(400).json({
        status: 'error',
        message: 'title tidak boleh kosong'
      });
    }
    
    if (!chapter) {
      return res.status(400).json({
        status: 'error',
        message: 'chapter tidak boleh kosong'
      });
    }
    
    // Get manga from database
    const manga = await Manga.findByPk(id_manga);
    if (!manga) {
      return res.status(404).json({
        status: 'error',
        message: 'Manga tidak ditemukan'
      });
    }
    
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
    
    // First download the images locally
    const localPaths = await chapterService.downloadChapterImages(
      image_chapter,
      manga.title,
      chapter
    );
    
    if (!localPaths || localPaths.length === 0) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to download any images'
      });
    }
    
    // Then upload to CDN
    const cdnUrls = await chapterService.uploadToCDN(
      localPaths,
      manga.title,
      chapter
    );
    
    if (!cdnUrls || cdnUrls.length === 0) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to upload any images to CDN'
      });
    }
    
    // Create chapter in WordPress
    const wpChapter = {
      post_chapter: chapter,
      id_manga: manga.wpId,
      id_author: wpUserId,
      post_content: cdnUrls
    };
    
    const wpResponse = await wpClient.createChapter(wpChapter);
    
    // Create chapter in local database
    const dbChapter = await Chapter.create({
      chapterNumber: chapter,
      title: title,
      wpId: wpResponse.id,
      wpUrl: wpResponse.url,
      mangaId: manga.id
    });
    
    // Add images to chapter
    for (let i = 0; i < cdnUrls.length; i++) {
      await ChapterImage.create({
        url: cdnUrls[i],
        order: i + 1,
        chapterId: dbChapter.id
      });
    }
    
    return res.status(201).json({
      status: 'success',
      message: `Chapter ${chapter} Berhasil di buat`,
      data: {
        id: dbChapter.id,
        wp_id: wpResponse.id,
        title: dbChapter.title,
        url: wpResponse.url,
        images_count: cdnUrls.length
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/chapter/full
 * @desc    Create multiple chapters at once
 * @access  Private
 */
router.post('/chapter/full', [
  authenticateJWT,
  body('id_manga').isInt().withMessage('id_manga harus berupa angka'),
  body('image_chapter').isArray().withMessage('image_chapter harus berupa array'),
  body('title').notEmpty().withMessage('title tidak boleh kosong'),
  body('chapters').isArray().withMessage('chapters harus berupa array')
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
    
    const { id_manga, image_chapter, title, chapters } = req.body;
    
    // Validate required fields
    if (!id_manga) {
      return res.status(400).json({
        status: 'error',
        message: 'id_manga tidak boleh kosong'
      });
    }
    
    if (!image_chapter || image_chapter.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'image_chapter tidak boleh kosong'
      });
    }
    
    if (!title) {
      return res.status(400).json({
        status: 'error',
        message: 'title tidak boleh kosong'
      });
    }
    
    if (!chapters || chapters.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'chapters tidak boleh kosong'
      });
    }
    
    if (chapters.length !== image_chapter.length) {
      return res.status(400).json({
        status: 'error',
        message: 'Jumlah chapters dan image_chapter harus sama'
      });
    }
    
    // Get manga from database
    const manga = await Manga.findByPk(id_manga);
    if (!manga) {
      return res.status(404).json({
        status: 'error',
        message: 'Manga tidak ditemukan'
      });
    }
    
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
    
    const results = [];
    const failedChapters = [];
    
    // Process each chapter
    for (let i = 0; i < chapters.length; i++) {
      try {
        const chapterNumber = chapters[i];
        const chapterImages = image_chapter[i];
        
        // First download the images locally
        const localPaths = await chapterService.downloadChapterImages(
          chapterImages,
          manga.title,
          chapterNumber
        );
        
        if (!localPaths || localPaths.length === 0) {
          failedChapters.push(chapterNumber);
          continue;
        }
        
        // Then upload to CDN
        const cdnUrls = await chapterService.uploadToCDN(
          localPaths,
          manga.title,
          chapterNumber
        );
        
        if (!cdnUrls || cdnUrls.length === 0) {
          failedChapters.push(chapterNumber);
          continue;
        }
        
        // Create chapter in WordPress
        const wpChapter = {
          post_chapter: chapterNumber,
          id_manga: manga.wpId,
          id_author: wpUserId,
          post_content: cdnUrls
        };
        
        const wpResponse = await wpClient.createChapter(wpChapter);
        
        // Create chapter in local database
        const chapterTitle = `${manga.title} Chapter ${chapterNumber}`;
        const dbChapter = await Chapter.create({
          chapterNumber: chapterNumber,
          title: chapterTitle,
          wpId: wpResponse.id,
          wpUrl: wpResponse.url,
          mangaId: manga.id
        });
        
        // Add images to chapter
        for (let j = 0; j < cdnUrls.length; j++) {
          await ChapterImage.create({
            url: cdnUrls[j],
            order: j + 1,
            chapterId: dbChapter.id
          });
        }
        
        // Add result
        results.push({
          chapter: chapterNumber,
          status: 'success',
          id: dbChapter.id,
          wp_id: wpResponse.id,
          title: dbChapter.title,
          url: wpResponse.url,
          images_count: cdnUrls.length
        });
      } catch (error) {
        failedChapters.push(chapters[i]);
        logger.error(`Error creating chapter ${chapters[i]}: ${error.message}`);
      }
    }
    
    return res.status(200).json({
      status: 'success',
      message: `Berhasil membuat ${results.length} chapter, gagal membuat ${failedChapters.length} chapter`,
      success_chapters: results,
      failed_chapters: failedChapters
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;