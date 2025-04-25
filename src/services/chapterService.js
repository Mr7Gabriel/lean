const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ScraperAdapter } = require('./scraperAdapter');
const cdnService = require('./cdnService');
const logger = require('../utils/logger');
const browserService = require('./browserService');

class ChapterService {
  constructor() {
    this.adapter = new ScraperAdapter();
    this.downloadDir = path.join(process.cwd(), 'downloads');
    
    // Create download directory if it doesn't exist
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  /**
   * Scrape chapter data from URL
   * @param {string} url - URL of chapter
   * @returns {object} - Chapter data
   */
  async scrapeChapter(url) {
    try {
      // Validate URL format
      try {
        new URL(url);
      } catch (error) {
        return {
          status: 'error',
          message: 'URL tidak valid',
          data: null
        };
      }
      
      // Get scraper for URL
      const scraper = this.adapter.getScraperForUrl(url, 'chapter');
      
      if (!scraper) {
        return {
          status: 'error',
          message: 'Scans Tidak Valid',
          data: null
        };
      }
      
      // Scrape chapter data
      let chapterData;
      try {
        chapterData = await scraper.scrapeChapter(url);
      } catch (error) {
        // Check if verification is required
        if (error.verificationUrl || error.sessionId) {
          const domain = error.domain || this._extractDomain(url);
          return {
            status: 'verification_required',
            message: `Verification required for site: ${domain}`,
            data: {
              verificationUrl: error.verificationUrl,
              sessionId: error.sessionId || '',
              domain: domain
            }
          };
        }
        throw error;
      }
      
      if (!chapterData) {
        return {
          status: 'error',
          message: 'Gagal mengambil data chapter',
          data: null
        };
      }
      
      // Standardize data format
      const standardizedData = this._standardizeChapterData(chapterData);
      
      return {
        status: 'success',
        message: 'Berhasil mengambil data chapter',
        data: standardizedData
      };
    } catch (error) {
      logger.error(`Error scraping chapter from ${url}: ${error.message}`);
      return {
        status: 'error',
        message: `Error: ${error.message}`,
        data: null
      };
    }
  }

  /**
   * Download chapter images to local storage
   * @param {Array} imageUrls - List of image URLs
   * @param {string} mangaTitle - Manga title
   * @param {string} chapterNumber - Chapter number
   * @returns {Array} - List of local file paths
   */
  async downloadChapterImages(imageUrls, mangaTitle, chapterNumber) {
    const downloadedPaths = [];
    
    try {
      // Sanitize manga title and chapter number for directory names
      const safeTitle = mangaTitle.replace(/[^\w\-_.]/g, '_');
      const safeChapter = chapterNumber.replace(/[^\w\-_.]/g, '_');
      
      // Create directory for downloaded images
      const downloadDir = path.join(this.downloadDir, safeTitle, `chapter_${safeChapter}`);
      fs.mkdirSync(downloadDir, { recursive: true });
      
      // Download each image
      for (let i = 0; i < imageUrls.length; i++) {
        try {
          // Add delay to avoid being blocked
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
          }
          
          const imageUrl = imageUrls[i];
          
          // Determine file extension
          const parsedUrl = new URL(imageUrl);
          const pathParts = parsedUrl.pathname.split('.');
          const fileExt = pathParts.length > 1 ? `.${pathParts[pathParts.length - 1]}` : '.jpg';
          
          // Create filename with padding for correct ordering
          const filename = `${String(i + 1).padStart(3, '0')}${fileExt}`;
          const outputPath = path.join(downloadDir, filename);
          
          try {
            // First try with normal HTTP request
            // Request with appropriate headers
            const response = await axios.get(imageUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': new URL(imageUrl).origin,
                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
              },
              responseType: 'arraybuffer',
              timeout: 15000
            });
            
            // Verify content type
            const contentType = response.headers['content-type'] || '';
            if (!contentType.startsWith('image/')) {
              throw new Error(`Response is not an image: ${contentType}`);
            }
            
            // Save image
            fs.writeFileSync(outputPath, response.data);
          } catch (axiosError) {
            // If HTTP request fails, try with Selenium
            logger.warn(`Failed to download image with HTTP request: ${axiosError.message}`);
            await browserService.downloadImage(imageUrl, outputPath);
          }
          
          downloadedPaths.push(outputPath);
          logger.info(`Downloaded ${i+1}/${imageUrls.length}: ${outputPath}`);
        } catch (error) {
          logger.error(`Error downloading image ${i+1}: ${error.message}`);
          continue;
        }
      }
      
      return downloadedPaths;
    } catch (error) {
      logger.error(`Error in downloadChapterImages: ${error.message}`);
      return downloadedPaths;
    }
  }

  /**
   * Upload chapter images to CDN
   * @param {Array} filePaths - List of local file paths
   * @param {string} mangaTitle - Manga title
   * @param {string} chapterNumber - Chapter number
   * @returns {Array} - List of CDN URLs
   */
  async uploadToCDN(filePaths, mangaTitle, chapterNumber) {
    const cdnUrls = [];
    
    try {
      // Sanitize manga title and chapter number for directory names
      const safeTitle = mangaTitle.replace(/[^\w\-_.]/g, '_');
      const safeChapter = chapterNumber.replace(/[^\w\-_.]/g, '_');
      
      // Make sure CDN folders exist
      const mirrorPath = "Mirror";
      await cdnService.ensureFolderExists(mirrorPath);
      
      const mangaPath = `${mirrorPath}/${safeTitle}`;
      await cdnService.ensureFolderExists(mangaPath);
      
      const chapterPath = `${mangaPath}/Chapter_${safeChapter}`;
      await cdnService.ensureFolderExists(chapterPath);
      
      // Upload each file
      for (let i = 0; i < filePaths.length; i++) {
        try {
          const filePath = filePaths[i];
          
          // Get file extension and create filename
          const fileExt = path.extname(filePath);
          const filename = `${String(i + 1).padStart(3, '0')}${fileExt}`;
          const cdnFilePath = `${chapterPath}/${filename}`;
          
          // Determine content type
          const contentType = this._getContentType(fileExt);
          
          // Read file data
          const fileData = fs.readFileSync(filePath);
          
          // Upload to CDN
          const publicUrl = await cdnService.uploadFile(
            fileData,
            cdnFilePath,
            contentType
          );
          
          cdnUrls.push(publicUrl);
          logger.info(`Uploaded ${i+1}/${filePaths.length} to CDN: ${publicUrl}`);
        } catch (error) {
          logger.error(`Error uploading file ${i+1} to CDN: ${error.message}`);
          continue;
        }
      }
      
      return cdnUrls;
    } catch (error) {
      logger.error(`Error in uploadToCDN: ${error.message}`);
      return cdnUrls;
    }
  }

  /**
   * Standardize chapter data to a common format
   * @param {object} chapterData - Raw chapter data from scraper
   * @returns {object} - Standardized chapter data
   * @private
   */
  _standardizeChapterData(chapterData) {
    // Extract chapter number
    let chapter = chapterData.chapter || '';
    if (!chapter) {
      // Try to extract from title
      const title = chapterData.title || '';
      const match = title.toLowerCase().match(/chapter\s+(\d+(?:\.\d+)?)/);
      if (match) {
        chapter = match[1];
      }
    }
    
    // Build standardized response
    return {
      title: chapterData.title || '',
      chapter: chapter,
      manga_title: chapterData.manga_title || '',
      image_chapter: chapterData.images || []
    };
  }

  /**
   * Get content type from file extension
   * @param {string} fileExt - File extension including dot
   * @returns {string} - MIME type
   * @private
   */
  _getContentType(fileExt) {
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp'
    };
    
    return contentTypes[fileExt.toLowerCase()] || 'image/jpeg';
  }

  /**
   * Extract domain from URL
   * @param {string} url - URL to extract domain from
   * @returns {string} Domain name
   * @private
   */
  _extractDomain(url) {
    try {
      const parsedUrl = new URL(url);
      let domain = parsedUrl.hostname;
      
      // Remove 'www.' prefix if present
      if (domain.startsWith('www.')) {
        domain = domain.substring(4);
      }
      
      return domain;
    } catch (e) {
      return '';
    }
  }
}

// Export as a singleton
module.exports = new ChapterService();