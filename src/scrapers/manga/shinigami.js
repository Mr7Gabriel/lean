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
    
    // Initialize axios-based scraper
    this.scraper = axios.create({
      timeout: 10000,
      headers: this._getRandomHeaders()
    });
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
      
      // Parse HTML with Cheerio instead of executeScript
      const $ = cheerio.load(html);
      
      // Initialize data object
      const data = {
        title: '',
        alternativeTitles: '',
        coverImage: '',
        description: '',
        status: '',
        type: '',
        releaseDate: '',
        author: '',
        artist: '',
        genres: '',
        score: ''
      };
      
      // Extract title
      const titleElem = $('h1.text-base-white.font-semibold');
      data.title = titleElem.length ? titleElem.text().trim() : '';
      
      // Extract alternative titles
      const altTitleElem = $('h3.text-base-white.font-medium');
      data.alternativeTitles = altTitleElem.length ? altTitleElem.text().trim() : '';
      
      // Extract cover image
      const coverElem = $('div.w-180 img');
      data.coverImage = coverElem.length ? coverElem.attr('src') : '';
      
      // Extract description
      const descElem = $('p');
      data.description = descElem.length ? descElem.text().trim() : '';
      
      // Extract status - might be in the second h3 element
      const statusElem = $('h3.text-base-white.font-medium').eq(1);
      data.status = statusElem.length ? statusElem.text().trim() : '';
      
      // Extract type
      const typeElem = $('button.border-2');
      data.type = typeElem.length ? typeElem.text().trim() : '';
      
      // Extract authors
      const authorElems = $('button:contains("Author")');
      const authors = [];
      authorElems.each((i, elem) => {
        authors.push($(elem).text().trim());
      });
      data.author = authors.join(', ');
      
      // Extract artists
      const artistElems = $('button:contains("Artist")');
      const artists = [];
      artistElems.each((i, elem) => {
        artists.push($(elem).text().trim());
      });
      data.artist = artists.join(', ');
      
      // Extract genres
      const genreElems = $('button:contains("Genre")');
      const genres = [];
      genreElems.each((i, elem) => {
        genres.push($(elem).text().trim());
      });
      data.genres = genres.join(', ');
      
      // Extract score
      const scoreElem = $('span.text-16.leading-22.font-medium.text-base-white');
      data.score = scoreElem.length ? scoreElem.text().trim() : '';
      
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