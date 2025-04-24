const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { BaseScraper } = require('../../services/scraperAdapter');
const browserService = require('../../services/browserService');
const logger = require('../../utils/logger');
const UserAgent = require('user-agents');

class ShinigamiScraper extends BaseScraper {
  constructor(baseUrl = null) {
    // Pass baseUrl to BaseScraper, which will be loaded from the database
    super(baseUrl);
    
    // Create download directory if it doesn't exist
    this.downloadDir = path.join(process.cwd(), 'downloads');
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  /**
   * Get random user-agent and headers for requests
   * @returns {object} Headers object
   * @private
   */
  _getRandomHeaders() {
    const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();
    
    return {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    };
  }

  /**
   * Sanitize filename by removing invalid characters
   * @param {string} filename - The filename to sanitize
   * @returns {string} Sanitized filename
   * @private
   */
  _sanitizeFilename(filename) {
    return filename.replace(/[^a-z0-9\s\-_]/gi, '_').trim();
  }

  /**
   * Scrape manga details from URL
   * @param {string} url - URL of manga page
   * @returns {Promise<object|null>} Dictionary of manga details or null on error
   */
  async scrape(url) {
    try {
      // Shinigami.site likely needs Selenium because of heavy JS and anti-bot
      const html = await browserService.getPage(url);
      
      // Execute JavaScript in the browser to extract data
      const data = await browserService.executeScript(`
        const extractText = (selector) => {
          const element = document.querySelector(selector);
          return element ? element.textContent.trim() : '';
        };

        const extractImage = (selector) => {
          const element = document.querySelector(selector);
          return element ? element.src : '';
        };

        const extractMultipleElements = (text, type='button') => {
          // Find all elements that match the text using a more flexible approach
          const elements = Array.from(document.querySelectorAll(type))
            .filter(el => el.textContent.trim().includes(text));
          return elements.map(el => el.textContent.trim());
        };

        return {
          title: extractText('h1.text-base-white.font-semibold'),
          alternativeTitles: extractText('h3.text-base-white.font-medium'),
          coverImage: extractImage('div.w-180 img'),
          description: extractText('p'),
          status: extractText('h3.text-base-white.font-medium'),
          type: extractText('button.border-2'),
          author: extractMultipleElements('Author'),
          artist: extractMultipleElements('Artist'),
          genres: extractMultipleElements('Genre'),
          score: extractText('span.text-16.leading-22.font-medium.text-base-white')
        };
      `, url);
      
      // Process the data
      if (data.author && Array.isArray(data.author)) {
        data.author = data.author.join(', ');
      }
      
      if (data.artist && Array.isArray(data.artist)) {
        data.artist = data.artist.join(', ');
      }
      
      if (data.genres && Array.isArray(data.genres)) {
        data.genres = data.genres.join(', ');
      }
      
      // Add empty releaseDate if not present
      if (!data.releaseDate) {
        data.releaseDate = '';
      }
      
      return data;
    } catch (error) {
      logger.error(`Error scraping ${url}: ${error.message}`);
      if (error.stack) {
        logger.error(error.stack);
      }
      return null;
    }
  }

  /**
   * Download manga cover image
   * @param {string} url - URL of manga page
   * @param {string|null} mangaTitle - Optional manga title for filename
   * @param {number} timeout - Timeout in seconds
   * @returns {Promise<string|null>} Path to downloaded cover file or null on error
   */
  async downloadCover(url, mangaTitle = null, timeout = 30) {
    try {
      // Get manga details to obtain cover URL
      const mangaDetails = await this.scrape(url);
      
      if (!mangaDetails || !mangaDetails.coverImage) {
        logger.warning("Cover URL not found");
        return null;
      }
      
      const coverUrl = mangaDetails.coverImage;
      
      // Determine manga title if not provided
      if (!mangaTitle) {
        mangaTitle = mangaDetails.title || 'unknown_manga';
      }
      
      // Sanitize filename
      const safeTitle = this._sanitizeFilename(mangaTitle);
      
      // Determine file extension
      const parsedUrl = new URL(coverUrl);
      const pathParts = parsedUrl.pathname.split('.');
      const fileExt = pathParts.length > 1 ? `.${pathParts[pathParts.length - 1]}` : '.jpg';
      
      // Output path
      const outputFilename = path.join(this.downloadDir, `${safeTitle}_cover${fileExt}`);
      
      // Need to use Selenium for Shinigami.site
      await browserService.downloadImage(coverUrl, outputFilename);
      
      logger.info(`Cover downloaded successfully: ${outputFilename}`);
      return outputFilename;
    } catch (error) {
      logger.error(`Error downloading cover: ${error.message}`);
      if (error.stack) {
        logger.error(error.stack);
      }
      return null;
    }
  }
}

module.exports = ShinigamiScraper;