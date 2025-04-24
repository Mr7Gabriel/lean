const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const { Scraper, ScraperDomain } = require('../db/models');
const logger = require('../utils/logger');

class BaseScraper {
  constructor(baseUrl = null) {
    this.baseUrl = baseUrl;
  }

  async scrape(url) {
    throw new Error('Method not implemented');
  }

  async scrapeChapter(url) {
    throw new Error('Method not implemented');
  }

  async downloadCover(url, mangaTitle = null) {
    throw new Error('Method not implemented');
  }
}

class ScraperAdapter {
  constructor() {
    this.scrapers = {};
    this.scraperDomains = {};
    
    // Load scrapers
    this.loadScrapers();
  }

  async loadScrapers() {
    try {
      // Get active scrapers from database
      const activeScrapers = await Scraper.findAll({
        where: { status: 'active' },
        include: [{
          model: ScraperDomain,
          where: { isActive: true }
        }]
      });
      
      for (const scraper of activeScrapers) {
        if (!scraper.ScraperDomains || scraper.ScraperDomains.length === 0) {
          logger.warn(`Scraper '${scraper.name}' has no active domains, skipping.`);
          continue;
        }
        
        try {
          // Get primary domain to determine base_url
          const primaryDomain = scraper.ScraperDomains.find(d => d.isPrimary) || scraper.ScraperDomains[0];
          const baseUrl = `https://${primaryDomain.domain}`;
          
          // Store domain to base_url mapping
          for (const domainObj of scraper.ScraperDomains) {
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
              for (const domainObj of scraper.ScraperDomains) {
                this.scrapers[`manga:${domainObj.domain}`] = MangaScraperClass;
              }
              
              logger.info(`Loaded manga scraper: ${scraper.name} for domains ${scraper.ScraperDomains.map(d => d.domain)}`);
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
                    for (const domainObj of scraper.ScraperDomains) {
                      this.scrapers[`chapter:${domainObj.domain}`] = this.scrapers[`manga:${domainObj.domain}`];
                    }
                    logger.info(`Using manga scraper for chapter scraping for ${scraper.name}`);
                  }
                  
                  continue;
                }
                
                const ChapterScraperClass = require(chapterModulePath);
                
                // Add to available chapter scrapers with all active domains
                for (const domainObj of scraper.ScraperDomains) {
                  this.scrapers[`chapter:${domainObj.domain}`] = ChapterScraperClass;
                }
                
                logger.info(`Loaded chapter scraper: ${scraper.name} for domains ${scraper.ScraperDomains.map(d => d.domain)}`);
              } catch (e) {
                logger.warn(`Failed to load chapter scraper '${scraper.name}': ${e.message}`);
                
                // If chapter module fails, try to use manga module for both if available
                if (scraper.type === 'both') {
                  for (const domainObj of scraper.ScraperDomains) {
                    this.scrapers[`chapter:${domainObj.domain}`] = this.scrapers[`manga:${domainObj.domain}`];
                  }
                  logger.info(`Using manga scraper for chapter scraping for ${scraper.name}`);
                }
              }
            } else if (scraper.type === 'both') {
              // If no chapter module specified but type is both, use manga module
              for (const domainObj of scraper.ScraperDomains) {
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

  async refreshScrapers() {
    this.scrapers = {};
    this.scraperDomains = {};
    await this.loadScrapers();
  }

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
      
      const mangaData = await scraper.scrape(url);
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
      
      const chapterData = await scraper.scrapeChapter(url);
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
      
      const coverPath = await scraper.downloadCover(url, mangaTitle);
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

  _standardizeChapterData(chapterData) {
    return {
      title: chapterData.title || '',
      chapter: chapterData.chapter || '',
      manga_title: chapterData.manga_title || '',
      image_chapter: chapterData.images || []
    };
  }

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