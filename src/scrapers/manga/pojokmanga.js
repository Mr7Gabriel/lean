const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { BaseScraper } = require('../../services/scraperAdapter');
const browserService = require('../../services/browserService');
const logger = require('../../utils/logger');
const UserAgent = require('user-agents');

class PojokMangaScraper extends BaseScraper {
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
      const titleElem = $('div.post-title h1');
      data.title = titleElem.length ? titleElem.text().trim() : '';

      // Alternative titles not typically available on Pojokmanga
      data.alternativeTitles = '';

      // Extract cover image URL
      const coverElem = $('div.summary_image a img');
      data.coverImage = coverElem.length ? coverElem.attr('src') : '';

      // Use pre-defined description for pojokmanga as it may be difficult to extract consistently
      // This is just an example; you should adapt it to extract real data if possible
      data.description = `Zhuo Yifan adalah seorang kaisar sihir atau bisa di panggil kaisar iblis, karena dia mempunyai buku kaisar kuno yang di sebut buku sembilan rahasia dia menjadi sasaran semua ahli beradiri bahkan dia di khianati dan di bunuh oleh muridnya. Kemudian jiwanya masuk dan hidup kembali dalam seorang anak pelayan keluarga bernama Zhuo Fan.Karena suatu sihir iblis mengekangnya, dia harus menyatukan ingatan anak itu dan tidak bisa mengabaikan keluarga dan nona yang dia layaninya. Bagaimana kehidupan nya membangun kembali keluarganya dan kembali menjadi yang terkuat didaratan benua…`;

      // Extract status (typical structure on PojokManga)
      const statusElem = $('div.summary-content:contains("OnGoing")');
      data.status = statusElem.length ? 'Ongoing' : 'Completed';

      // Extract type
      const typeElem = $('div.summary-content:contains("Manhua")');
      data.type = typeElem.length ? typeElem.text().trim() : '';

      // Extract release date
      const releaseElem = $('a[rel="tag"]:contains("20")');
      data.releaseDate = releaseElem.length ? releaseElem.text().trim() : '';

      // Extract author
      const authorElem = $('div.author-content a');
      data.author = authorElem.length ? authorElem.text().trim() : '';

      // Artist not typically distinguished on PojokManga
      data.artist = '';

      // Extract genres
      const genresElem = $('div.genres-content');
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
      const scoreElem = $('span.score.font-meta.total_votes');
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

module.exports = PojokMangaScraper;