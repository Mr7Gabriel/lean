const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { BaseScraper } = require('../../services/scraperAdapter');
const browserService = require('../../services/browserService');
const logger = require('../../utils/logger');
const UserAgent = require('user-agents');

class KomikcastScraper extends BaseScraper {
  constructor(baseUrl = null) {
    // Pass baseUrl to BaseScraper, which will be loaded from the database
    super(baseUrl);
    
    // Create download directory if it doesn't exist
    this.downloadDir = path.join(process.cwd(), 'downloads');
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }

    // Initialize axios-based scraper with cloud protection bypass
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
        logger.warn(`Standard request failed, switching to Selenium: ${error.message}`);
        html = await this._getWithSelenium(url);
      }
      
      // Parse HTML with Cheerio (equivalent to BeautifulSoup)
      const $ = cheerio.load(html);
      
      // Initialize data object - FROM KOMIKCAST.JS
      const data = {};

      // Extract title
      const titleElem = $('h1.komik_info-content-body-title[itemprop="headline"]');
      if (titleElem.length) {
        // Remove "Bahasa Indonesia" if present
        const title = titleElem.text().replace(/\s*Bahasa Indonesia\s*/i, '');
        data.title = title.trim();
      } else {
        data.title = '';
      }

      // Extract alternative title
      const altTitleElem = $('span.komik_info-content-native');
      data.alternativeTitles = altTitleElem.length ? altTitleElem.text().trim() : '';

      // Extract cover image URL
      const coverElem = $('div.komik_info-content-thumbnail img');
      data.coverImage = coverElem.length ? coverElem.attr('src') : '';

      // Extract description
      const descElem = $('p[style="text-align: justify;"]');
      data.description = descElem.length ? descElem.text().trim() : '';

      // Extract status
      const statusElem = $('span.komik_info-content-info:contains("Status:") b');
      data.status = statusElem.length ? statusElem.text().trim() : '';

      // Extract type
      const typeElem = $('span.komik_info-content-info-type:contains("Type:") a');
      data.type = typeElem.length ? typeElem.text().trim() : '';

      // Extract release date
      const releaseElem = $('span.komik_info-content-info-release:contains("Released:") b');
      data.releaseDate = releaseElem.length ? releaseElem.text().trim() : '';

      // Extract author and artist
      const creatorElem = $('span.komik_info-content-info:contains("Author:")');
      if (creatorElem.length) {
        const creatorText = creatorElem.text().trim();
        // Extract author and artist using regex
        const authorMatch = creatorText.match(/Author:\s*Author\(s\)\s*(.*?),\s*Artist\(s\)\s*(.*?)(?:$|,)/);
        if (authorMatch) {
          data.author = authorMatch[1].trim();
          data.artist = authorMatch[2].trim();
        } else {
          data.author = '';
          data.artist = '';
        }
      } else {
        data.author = '';
        data.artist = '';
      }

      // Extract genres
      const genresElem = $('span.komik_info-content-genre');
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
      const scoreElem = $('div.data-rating[data-ratingkomik]');
      data.score = scoreElem.length ? scoreElem.attr('data-ratingkomik') : '';

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
   * Scrape chapter data from URL (adapted from kiryuu.js)
   * @param {string} url - URL of chapter page
   * @returns {Promise<object|null>} Dictionary of chapter data or null on error
   */
  async scrapeChapter(url) {
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
        logger.warn(`Standard request failed, switching to Selenium: ${error.message}`);
        html = await this._getWithSelenium(url);
      }
      
      // Parse HTML with Cheerio
      const $ = cheerio.load(html);
      
      // Initialize data object
      const data = {
        title: '',
        chapter: '',
        manga_title: '',
        images: []
      };
      
      // Extract chapter title and number
      const titleElem = $('h1.entry-title');
      if (titleElem.length) {
        data.title = titleElem.text().trim();
        
        // Extract chapter number from title
        const chapterMatch = data.title.match(/Chapter\s+(\d+(?:\.\d+)?)/);
        if (chapterMatch) {
          data.chapter = chapterMatch[1];
        }
      }
      
      // Extract manga title - using komikcast specific selectors
      const mangaLink = $('div.chapter-headpost a');
      if (mangaLink.length) {
        data.manga_title = mangaLink.text().trim();
      }
      
      // Extract chapter images
      const imageContainer = $('#readerarea');
      if (imageContainer.length) {
        imageContainer.find('img').each((i, elem) => {
          // Get image URL from src, data-src, or data-lazy-src attributes
          const imgUrl = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-lazy-src');
          if (imgUrl && !imgUrl.includes('komikcast') && !imgUrl.includes('logo')) {
            data.images.push(imgUrl);
          }
        });
      }
      
      // If no images found, try alternative method (for lazy-loaded images)
      if (data.images.length === 0) {
        $('div#readerareaimg p img').each((i, elem) => {
          const imgUrl = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-lazy-src');
          if (imgUrl) {
            data.images.push(imgUrl);
          }
        });
      }
      
      // If still no images found, look for js array
      if (data.images.length === 0) {
        const scriptContent = $('script:contains("ts_reader")').html();
        if (scriptContent) {
          const imageArrayMatch = scriptContent.match(/images\s*=\s*(\[.*?\])/s);
          if (imageArrayMatch) {
            try {
              const imagesJson = imageArrayMatch[1].replace(/'/g, '"');
              const images = JSON.parse(imagesJson);
              data.images = images;
            } catch (e) {
              logger.warn(`Failed to parse images array: ${e.message}`);
            }
          }
        }
      }
      
      // If no chapter number was found, try to extract from URL
      if (!data.chapter) {
        const chapterMatch = url.match(/chapter-(\d+(?:-\d+)?)/);
        if (chapterMatch) {
          // Convert from URL format (e.g., chapter-10-5 to 10.5)
          const chNum = chapterMatch[1].replace('-', '.');
          data.chapter = chNum;
          if (!data.title) {
            data.title = `Chapter ${chNum}`;
          }
        }
      }
      
      return data;
    } catch (error) {
      logger.error(`Error scraping chapter ${url}: ${error.message}`);
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
        logger.warn("Cover URL not found");
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
        logger.warn(`Failed to download cover with axios: ${error.message}`);
        
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

module.exports = KomikcastScraper;