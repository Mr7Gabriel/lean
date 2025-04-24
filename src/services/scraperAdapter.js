const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const { Scraper, ScraperDomain } = require('../db/models');
const logger = require('../utils/logger');

/**
 * Base scraper class that all specific website scrapers extend
 */
class BaseScraper {
  /**
   * @param {string|null} baseUrl - Base URL loaded from database
   */
  constructor(baseUrl = null) {
    this.baseUrl = baseUrl;
  }

  /**
   * Scrape manga details from URL
   * @param {string} url - URL of manga page
   * @returns {Promise<object|null>} Dictionary of manga details or null on error
   */
  async scrape(url) {
    throw new Error('Method not implemented');
  }

  /**
   * Scrape chapter data from URL
   * @param {string} url - URL of chapter page
   * @returns {Promise<object|null>} Dictionary of chapter data or null on error
   */
  async scrapeChapter(url) {
    throw new Error('Method not implemented');
  }

  /**
   * Download manga cover image
   * @param {string} url - URL of manga page
   * @param {string|null} mangaTitle - Optional manga title for filename
   * @returns {Promise<string|null>} Path to downloaded cover file or null on error
   */
  async downloadCover(url, mangaTitle = null) {
    throw new Error('Method not implemented');
  }
}

/**
 * Adapter class that provides access to all available scrapers
 */
class ScraperAdapter {
  constructor() {
    // Map of scraper keys to scraper classes
    this.scrapers = {};
    
    // Map of domains to their base URLs
    this.scraperDomains = {};
    
    // Load scrapers from database
    this.loadScrapers();
  }

  /**
   * Load scrapers from database
   * @returns {Promise<void>}
   */
  async loadScrapers() {
    try {
      // Get active scrapers from database
      const activeScrapers = await Scraper.findAll({
        where: { status: 'active' },
        include: [{
          model: ScraperDomain,
          as: 'domains',
          where: { isActive: true },
          required: false
        }]
      });
      
      for (const scraper of activeScrapers) {
        if (!scraper.domains || scraper.domains.length === 0) {
          logger.warn(`Scraper '${scraper.name}' has no active domains, skipping.`);
          continue;
        }
        
        try {
          // Get primary domain to determine base_url
          const primaryDomain = scraper.domains.find(d => d.isPrimary) || scraper.domains[0];
          const baseUrl = `https://${primaryDomain.domain}`;
          
          // Store domain to base_url mapping
          for (const domainObj of scraper.domains) {
            this.scraperDomains[domainObj.domain] = baseUrl;
          }
          
          // Attempt to import scraper module
          if (scraper.type === 'manga' || scraper.type === 'both') {
            try {
              const mangaModulePath = path.join(__dirname, '..', 'scrapers', 'manga', `${scraper.mangaModule}.js`);
              
              if (!fs.existsSync(mangaModulePath)) {
                logger.warn(`Manga scraper module not found: ${mangaModulePath}`);
                continue;
              }
              
              const MangaScraperClass = require(mangaModulePath);
              
              // Add to available manga scrapers with all active domains
              for (const domainObj of scraper.domains) {
                this.scrapers[`manga:${domainObj.domain}`] = MangaScraperClass;
              }
              
              logger.info(`Loaded manga scraper: ${scraper.name} for domains ${scraper.domains.map(d => d.domain)}`);
            } catch (e) {
              logger.warn(`Failed to load manga scraper '${scraper.name}': ${e.message}`);
            }
          }
          
          // Then try to load chapter module if available and different
          if (scraper.type === 'chapter' || scraper.type === 'both') {
            // Check if chapter module is specified
            if (scraper.chapterModule) {
              try {
                const chapterModulePath = path.join(__dirname, '..', 'scrapers', 'chapter', `${scraper.chapterModule}.js`);
                
                if (!fs.existsSync(chapterModulePath)) {
                  logger.warn(`Chapter scraper module not found: ${chapterModulePath}`);
                  
                  // If chapter module fails, try to use manga module for both if available
                  if (scraper.type === 'both') {
                    for (const domainObj of scraper.domains) {
                      this.scrapers[`chapter:${domainObj.domain}`] = this.scrapers[`manga:${domainObj.domain}`];
                    }
                    logger.info(`Using manga scraper for chapter scraping for ${scraper.name}`);
                  }
                  
                  continue;
                }
                
                const ChapterScraperClass = require(chapterModulePath);
                
                // Add to available chapter scrapers with all active domains
                for (const domainObj of scraper.domains) {
                  this.scrapers[`chapter:${domainObj.domain}`] = ChapterScraperClass;
                }
                
                logger.info(`Loaded chapter scraper: ${scraper.name} for domains ${scraper.domains.map(d => d.domain)}`);
              } catch (e) {
                logger.warn(`Failed to load chapter scraper '${scraper.name}': ${e.message}`);
                
                // If chapter module fails, try to use manga module for both if available
                if (scraper.type === 'both') {
                  for (const domainObj of scraper.domains) {
                    this.scrapers[`chapter:${domainObj.domain}`] = this.scrapers[`manga:${domainObj.domain}`];
                  }
                  logger.info(`Using manga scraper for chapter scraping for ${scraper.name}`);
                }
              }
            } else if (scraper.type === 'both') {
              // If no chapter module specified but type is both, use manga module
              for (const domainObj of scraper.domains) {
                this.scrapers[`chapter:${domainObj.domain}`] = this.scrapers[`manga:${domainObj.domain}`];
              }
              logger.info(`Using manga scraper for chapter scraping for ${scraper.name}`);
            }
          }
        } catch (e) {
          logger.error(`Error loading scraper '${scraper.name}': ${e.message}`);
        }
      }
    } catch (e) {
      logger.error(`Error loading scrapers: ${e.message}`);
    }
  }

  /**
   * Refresh scrapers from database
   * @returns {Promise<void>}
   */
  async refreshScrapers() {
    this.scrapers = {};
    this.scraperDomains = {};
    await this.loadScrapers();
  }

  /**
   * Get appropriate scraper for a URL
   * @param {string} url - URL to find scraper for
   * @param {string} scraperType - Type of scraper ('manga' or 'chapter')
   * @returns {BaseScraper|null} Scraper instance or null if none found
   */
  getScraperForUrl(url, scraperType = 'manga') {
    try {
      // Parse the domain from URL
      const parsedUrl = new URL(url);
      let domain = parsedUrl.hostname;
      
      // Remove 'www.' prefix if present
      if (domain.startsWith('www.')) {
        domain = domain.substring(4);
      }
      
      // Look for exact domain match with scraper type
      const scraperKey = `${scraperType}:${domain}`;
      if (this.scrapers[scraperKey]) {
        // Get base_url from scraperDomains
        const baseUrl = this.scraperDomains[domain];
        return new this.scrapers[scraperKey](baseUrl);
      }
      
      // Look for partial domain match
      for (const key in this.scrapers) {
        if (!key.startsWith(`${scraperType}:`)) {
          continue;
        }
        
        const scraperDomain = key.split(':', 2)[1];
        if (domain.includes(scraperDomain)) {
          // Get base_url from scraperDomains
          const baseUrl = this.scraperDomains[scraperDomain] || `https://${scraperDomain}`;
          return new this.scrapers[key](baseUrl);
        }
      }
      
      // No suitable scraper found
      logger.warn(`No suitable ${scraperType} scraper found for domain: ${domain}`);
      return null;
    } catch (e) {
      logger.error(`Error getting scraper for URL ${url}: ${e.message}`);
      return null;
    }
  }

  /**
   * Scrape manga details from URL with Cloudflare verification handling
   * @param {string} url - URL of manga page
   * @returns {Promise<object>} Response object with status, message, and data
   */
  async scrapeManga(url) {
    try {
      const scraper = this.getScraperForUrl(url, 'manga');
      if (!scraper) {
        return {
          status: 'error',
          message: 'Scans Tidak Valid',
          data: null
        };
      }
      
      let mangaData;
      try {
        mangaData = await scraper.scrape(url);
      } catch (error) {
        // Check if this is a verification required error
        if (error.verificationUrl) {
          return {
            status: 'verification_required',
            message: `Verification required for site: ${error.domain || 'unknown'}`,
            data: {
              verificationUrl: error.verificationUrl,
              sessionId: error.sessionId,
              domain: error.domain
            }
          };
        }
        throw error;
      }
      
      if (!mangaData) {
        return {
          status: 'error',
          message: 'Gagal mengambil data manga',
          data: null
        };
      }
      
      // Standardize data for response
      const standardizedData = this._standardizeMangaData(mangaData);
      
      return {
        status: 'success',
        message: 'Berhasil mengambil data manga',
        data: standardizedData
      };
    } catch (e) {
      logger.error(`Error in scrapeManga: ${e.message}`);
      return {
        status: 'error',
        message: `Error: ${e.message}`,
        data: null
      };
    }
  }

  /**
   * Scrape chapter data from URL
   * @param {string} url - URL of chapter page
   * @returns {Promise<object>} Response object with status, message, and data
   */
  async scrapeChapter(url) {
    try {
      const scraper = this.getScraperForUrl(url, 'chapter');
      if (!scraper) {
        return {
          status: 'error',
          message: 'Scans Tidak Valid',
          data: null
        };
      }
      
      let chapterData;
      try {
        chapterData = await scraper.scrapeChapter(url);
      } catch (error) {
        // Check if this is a verification required error
        if (error.verificationUrl) {
          return {
            status: 'verification_required',
            message: `Verification required for site: ${error.domain || 'unknown'}`,
            data: {
              verificationUrl: error.verificationUrl,
              sessionId: error.sessionId,
              domain: error.domain
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
      
      // Standardize data for response
      const standardizedData = this._standardizeChapterData(chapterData);
      
      return {
        status: 'success',
        message: 'Berhasil mengambil data chapter',
        data: standardizedData
      };
    } catch (e) {
      logger.error(`Error in scrapeChapter: ${e.message}`);
      return {
        status: 'error',
        message: `Error: ${e.message}`,
        data: null
      };
    }
  }

  /**
   * Download cover image from manga URL
   * @param {string} url - URL of manga page
   * @param {string|null} mangaTitle - Optional manga title for filename
   * @returns {Promise<object>} Response object with status, message, and data
   */
  async downloadCover(url, mangaTitle = null) {
    try {
      const scraper = this.getScraperForUrl(url, 'manga');
      if (!scraper) {
        return {
          status: 'error',
          message: 'Scans Tidak Valid',
          data: null
        };
      }
      
      let coverPath;
      try {
        coverPath = await scraper.downloadCover(url, mangaTitle);
      } catch (error) {
        // Check if this is a verification required error
        if (error.verificationUrl) {
          return {
            status: 'verification_required',
            message: `Verification required for site: ${error.domain || 'unknown'}`,
            data: {
              verificationUrl: error.verificationUrl,
              sessionId: error.sessionId,
              domain: error.domain
            }
          };
        }
        throw error;
      }
      
      if (!coverPath) {
        return {
          status: 'error',
          message: 'Gagal mengunduh cover',
          data: null
        };
      }
      
      return {
        status: 'success',
        message: 'Berhasil mengunduh cover',
        data: {
          path: coverPath
        }
      };
    } catch (e) {
      logger.error(`Error in downloadCover: ${e.message}`);
      return {
        status: 'error',
        message: `Error: ${e.message}`,
        data: null
      };
    }
  }

  /**
   * Standardize manga data format
   * @param {object} mangaData - Raw manga data from scraper
   * @returns {object} Standardized manga data
   * @private
   */
  _standardizeMangaData(mangaData) {
    // Extract genres as list if it's a string
    let genres = mangaData.genres || [];
    if (typeof genres === 'string') {
      // Split by comma and strip whitespace
      genres = genres.split(',').map(g => g.trim()).filter(g => g);
    }
    
    // Convert score to float
    let score = 0.0;
    try {
      score = parseFloat(mangaData.score) || 0.0;
    } catch (e) {
      score = 0.0;
    }
    
    // Map status to enum values
    const statusMap = {
      'ongoing': 'Ongoing',
      'complete': 'Completed',
      'completed': 'Completed',
      'hiatus': 'Hiatus'
    };
    const status = statusMap[(mangaData.status || '').toLowerCase()] || 'Ongoing';
    
    // Map type to enum values
    const typeMap = {
      'manga': 'Manga',
      'manhua': 'Manhua',
      'manhwa': 'Manhwa',
      'comic': 'Comic',
      'novel': 'Novel'
    };
    const mangaType = typeMap[(mangaData.type || '').toLowerCase()] || 'Manga';
    
    return {
      title: mangaData.title || '',
      title_alt: mangaData.alternativeTitles || '',
      author: mangaData.author || '',
      artist: mangaData.artist || '',
      genre: genres,
      status: status,
      description: mangaData.description || '',
      thumbnail: mangaData.coverImage || '',
      hot: false,
      project: false,
      score: score,
      type: mangaType,
      serialization: '',
      published: mangaData.releaseDate || ''
    };
  }

  /**
   * Standardize chapter data format
   * @param {object} chapterData - Raw chapter data from scraper
   * @returns {object} Standardized chapter data
   * @private
   */
  _standardizeChapterData(chapterData) {
    return {
      title: chapterData.title || '',
      chapter: chapterData.chapter || '',
      manga_title: chapterData.manga_title || '',
      image_chapter: chapterData.images || []
    };
  }

  /**
   * Extract domain from URL
   * @param {string} url - URL to extract domain from
   * @returns {string} Domain name
   * @static
   */
  static getDomainFromUrl(url) {
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

module.exports = { ScraperAdapter, BaseScraper };