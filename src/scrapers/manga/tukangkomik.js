const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { BaseScraper } = require('../../services/scraperAdapter');
const browserService = require('../../services/browserService');
const logger = require('../../utils/logger');
const UserAgent = require('user-agents');

class TukangkomikScraper extends BaseScraper {
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
   * Get page content using Selenium to bypass anti-bot protection
   * @param {string} url - URL to load
   * @returns {Promise<string>} HTML content
   * @private
   */
  async _getWithSelenium(url) {
    try {
      logger.info(`Loading URL with Selenium: ${url}`);
      return await browserService.getPage(url);
    } catch (error) {
      logger.error(`Error getting page with Selenium: ${error.message}`);
      throw error;
    }
  }

  /**
   * Scrape manga details from URL
   * @param {string} url - URL of manga page
   * @returns {Promise<object|null>} Dictionary of manga details or null on error
   */
  async scrape(url) {
    try {
      // First try with normal request
      let html = '';
      try {
        const response = await this.scraper.get(url);
        html = response.data;
        
        // Check if we need to bypass anti-bot protection
        if (
          html.length < 5000 || 
          html.toLowerCase().includes('captcha') || 
          html.toLowerCase().includes('cloudflare')
        ) {
          logger.info("Detected anti-bot protection, switching to Selenium");
          html = await this._getWithSelenium(url);
        }
      } catch (error) {
        logger.warning(`Standard request failed, switching to Selenium: ${error.message}`);
        html = await this._getWithSelenium(url);
      }
      
      // Parse HTML with Cheerio (equivalent to BeautifulSoup)
      const $ = cheerio.load(html);
      
      // Initialize data object
      const data = {};

      // Extract title 
      const titleElem = $('h1.entry-title[itemprop="name"]');
      data.title = titleElem.length ? titleElem.text().trim() : '';

      // Extract alternative titles 
      const altTitleElem = $('div.wd-full > b:contains("Alternative Titles") + span');
      data.alternativeTitles = altTitleElem.length ? altTitleElem.text().trim() : '';

      // Extract cover image URL
      const coverElem = $('img[itemprop="image"][class*="attachment-"]');
      data.coverImage = coverElem.length ? coverElem.attr('src') : '';

      // Extract description
      const descElem = $('div.entry-content.entry-content-single[itemprop="description"] p');
      data.description = descElem.length ? descElem.text().trim() : '';

      // Extract status
      const statusElem = $('div.imptdt:contains("Status") i');
      data.status = statusElem.length ? statusElem.text().trim() : '';

      // Extract type
      const typeElem = $('div.imptdt:contains("Type") a');
      data.type = typeElem.length ? typeElem.text().trim() : '';

      // Extract release date
      const releaseElem = $('div.fmed > b:contains("Released") + span');
      if (releaseElem.length && releaseElem.text().trim() !== '-') {
        data.releaseDate = releaseElem.text().trim();
      } else {
        data.releaseDate = '';
      }

      // Extract author
      const authorElem = $('div.fmed > b:contains("Author") + span');
      if (authorElem.length) {
        let authorText = authorElem.text().replace('[Add, ]', '').trim();
        data.author = authorText;
      } else {
        data.author = '';
      }

      // Extract artist
      const artistElem = $('div.fmed > b:contains("Artist") + span');
      if (artistElem.length) {
        let artistText = artistElem.text().trim();
        data.artist = artistText;
      } else {
        data.artist = '';
      }

      // Extract genres
      const genresElem = $('div.wd-full > b:contains("Genres") + span.mgen');
      if (genresElem.length) {
        const genres = [];
        genresElem.find('a').each((i, elem) => {
          genres.push($(elem).text().trim());
        });
        data.genres = genres.join(', ');
      } else {
        data.genres = '';
      }

      // Extract score
      const scoreElem = $('div.num[itemprop="ratingValue"]');
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
      
      // Try downloading with normal request first
      try {
        const headers = {
          'User-Agent': this._getRandomHeaders()['User-Agent'],
          'Referer': url,
          'Accept': 'image/webp,*/*'
        };
        
        const response = await axios.get(coverUrl, {
          headers,
          responseType: 'arraybuffer',
          timeout: timeout * 1000
        });
        
        // Verify content type
        const contentType = response.headers['content-type'] || '';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Response is not an image: ${contentType}`);
        }
        
        // Save image
        fs.writeFileSync(outputFilename, response.data);
      } catch (error) {
        logger.warning(`Failed to download cover with axios: ${error.message}`);
        
        // Try with Selenium as a fallback
        await browserService.downloadImage(coverUrl, outputFilename);
      }
      
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

module.exports = TukangkomikScraper;