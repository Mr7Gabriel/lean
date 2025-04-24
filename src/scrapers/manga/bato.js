const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { BaseScraper } = require('../../services/scraperAdapter');
const browserService = require('../../services/browserService');
const logger = require('../../utils/logger');

class BatoScraper extends BaseScraper {
  constructor(baseUrl = 'https://bato.to') {
    super(baseUrl);
    
    // Create download directory if it doesn't exist
    this.downloadDir = path.join(process.cwd(), 'downloads');
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
    
    // User agents for requests
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36'
    ];
  }

  _getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  _sanitizeFilename(filename) {
    return filename.replace(/[^a-z0-9\s\-_]/gi, '_').trim();
  }

  async scrape(url) {
    try {
      // Try to fetch with normal request first
      let html = '';
      try {
        const headers = {
          'User-Agent': this._getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        };
        
        const response = await axios.get(url, { headers });
        html = response.data;
        
        // Check if we need bypass (very small response or contains captcha/cloudflare)
        if (html.length < 5000 || 
            html.toLowerCase().includes('captcha') ||
            html.toLowerCase().includes('cloudflare')) {
          logger.info('Detected anti-bot protection, switching to Selenium');
          html = await browserService.getPage(url);
        }
      } catch (error) {
        logger.warn(`Normal request failed, switching to Selenium: ${error.message}`);
        html = await browserService.getPage(url);
      }
      
      // Check for page version (v3 or v2)
      const data = {};
      
      if (url.includes('v3')) {
        // Scraping for v3 Bato.to
        const titleMatch = html.match(/<h3 class="text-lg md:text-2xl font-bold">(.*?)<\/h3>/);
        data.title = titleMatch ? titleMatch[1] : '';
        
        const altTitleMatch = html.match(/<div class="mt-1 text-xs md:text-base opacity-80">(.*?)<\/div>/);
        data.alternativeTitles = altTitleMatch ? altTitleMatch[1] : '';
        
        const coverMatch = html.match(/<img class="w-full not-prose shadow-md shadow-black\/50" src="(.*?)"/);
        data.coverImage = coverMatch ? coverMatch[1] : '';
        
        const descMatch = html.match(/<div class="prose lg:prose-lg limit-html">(.*?)<\/div>/s);
        data.description = descMatch ? descMatch[1].trim() : '';
        
        const authorMatch = html.match(/<div class="attr-item">.*?Authors: (.*?)<\/div>/s);
        data.author = authorMatch ? authorMatch[1] : '';
        
        const artistMatch = html.match(/<div class="attr-item">.*?Artists: (.*?)<\/div>/s);
        data.artist = artistMatch ? artistMatch[1] : '';
        
        const releaseMatch = html.match(/<div class="attr-item">.*?Year of Release: (.*?)<\/div>/s);
        data.releaseDate = releaseMatch ? releaseMatch[1] : '';
        
        const statusMatch = html.match(/<div class="attr-item">.*?Original work: (.*?)<\/div>/s);
        data.status = statusMatch ? statusMatch[1] : '';
        
        const typeMatch = html.match(/<span class="font-bold">(.*?)<\/span>/);
        data.type = typeMatch ? typeMatch[1] : '';
        
        // Extract genres
        const genresMatches = html.match(/<div class="flex items-center flex-wrap span">(.*?)<\/div>/g);
        if (genresMatches) {
          const genresText = genresMatches.join(' ').replace(/<.*?>/g, ' ');
          data.genres = genresText.split(/\s+/).filter(Boolean).join(', ');
        } else {
          data.genres = '';
        }
      } else if (url.includes('v2')) {
        // Scraping for v2 Bato.to
        const titleMatch = html.match(/<h1 class="title">.*?<span class="text-2xl">(.*?)<\/span>/);
        data.title = titleMatch ? titleMatch[1] : '';
        
        const altTitleMatch = html.match(/<div class="mt-2">.*?<span class="text-sm">(.*?)<\/span>/);
        data.alternativeTitles = altTitleMatch ? altTitleMatch[1] : '';
        
        const coverMatch = html.match(/<div class="cover-img">.*?<img src="(.*?)"/);
        data.coverImage = coverMatch ? coverMatch[1] : '';
        
        const descMatch = html.match(/<div class="desc">.*?<p>(.*?)<\/p>/s);
        data.description = descMatch ? descMatch[1].trim() : '';
        
        const authorMatch = html.match(/Authors: <span class="author">.*?<a.*?>(.*?)<\/a>/);
        data.author = authorMatch ? authorMatch[1] : '';
        
        const artistMatch = html.match(/Artists: <span class="artist">.*?<a.*?>(.*?)<\/a>/);
        data.artist = artistMatch ? artistMatch[1] : '';
        
        const releaseMatch = html.match(/Year of Release: <span class="year">(.*?)<\/span>/);
        data.releaseDate = releaseMatch ? releaseMatch[1] : '';
        
        const statusMatch = html.match(/Status: <span class="status">(.*?)<\/span>/);
        data.status = statusMatch ? statusMatch[1] : '';
        
        const typeMatch = html.match(/Type: <span class="type">(.*?)<\/span>/);
        data.type = typeMatch ? typeMatch[1] : '';
        
        const genresMatch = html.match(/Genres: <span class="genres">(.*?)<\/span>/);
        data.genres = genresMatch ? genresMatch[1] : '';
      } else {
        // Generic approach for other versions using Cheerio
        const $ = cheerio.load(html);
        
        // Try to extract title
        const titleElem = $('h1').first() || $('h3[class*="title"]').first();
        data.title = titleElem ? titleElem.text().trim() : '';
        
        // Try to extract cover
        const coverElem = $('img[class*="cover"], img[class*="thumbnail"]').first();
        data.coverImage = coverElem ? coverElem.attr('src') : '';
        
        // Try to extract description
        const descElem = $('div[class*="description"], div[class*="summary"]').first();
        data.description = descElem ? descElem.text().trim() : '';
        
        // Set defaults for other fields
        data.alternativeTitles = '';
        data.author = '';
        data.artist = '';
        data.releaseDate = '';
        data.status = '';
        data.type = 'Manga';
        data.genres = '';
      }
      
      // Extract score for all versions
      const scoreMatch = html.match(/<div class="score">.*?<span class="rating">(.*?)<\/span>/);
      data.score = scoreMatch ? scoreMatch[1].trim() : '';
      
      return data;
    } catch (error) {
      logger.error(`Error scraping ${url}: ${error.message}`);
      return null;
    }
  }

  async scrapeChapter(url) {
    try {
      // Fetch the HTML content
      let html = '';
      try {
        const headers = {
          'User-Agent': this._getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        };
        
        const response = await axios.get(url, { headers });
        html = response.data;
        
        // Check if we need bypass
        if (html.length < 5000 || 
            html.toLowerCase().includes('captcha') ||
            html.toLowerCase().includes('cloudflare')) {
          logger.info('Detected anti-bot protection, switching to Selenium');
          html = await browserService.getPage(url);
        }
      } catch (error) {
        logger.warn(`Normal request failed, switching to Selenium: ${error.message}`);
        html = await browserService.getPage(url);
      }
      
      // Parse the HTML
      const $ = cheerio.load(html);
      
      // Initialize data object
      const data = {
        title: '',
        chapter: '',
        manga_title: '',
        images: []
      };
      
      // Extract chapter and manga title
      const titleElem = $('title');
      if (titleElem.length) {
        const titleText = titleElem.text();
        // Try to parse format "Chapter X - Manga Title"
        const match = titleText.match(/Chapter\s+(\d+(?:\.\d+)?)\s+-\s+(.+?)(?:\s+\||\s*$)/);
        if (match) {
          data.chapter = match[1];
          data.manga_title = match[2].trim();
          data.title = `Chapter ${match[1]}`;
        }
      }
      
      // Method 1: Direct image containers
      const imgContainer = $('div[class*="reader"], div[class*="chapter-content"]');
      if (imgContainer.length) {
        imgContainer.find('img').each((_, img) => {
          const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-original') || $(img).attr('data-lazy-src');
          if (src && !src.endsWith('.gif') && !src.toLowerCase().includes('logo')) {
            data.images.push(src);
          }
        });
      }
      
      // Method 2: JavaScript array
      if (data.images.length === 0) {
        // Try to find image list in JavaScript
        const imageArrayMatch = html.match(/const\s+images\s*=\s*(\[.*?\])/s) ||
                                html.match(/var\s+images\s*=\s*(\[.*?\])/s);
        
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
      
      // If no chapter number was found, try to extract from URL
      if (!data.chapter) {
        const chapterMatch = url.match(/chapter[_-](\d+(?:\.\d+)?)/);
        if (chapterMatch) {
          data.chapter = chapterMatch[1];
          data.title = `Chapter ${chapterMatch[1]}`;
        }
      }
      
      return data;
    } catch (error) {
      logger.error(`Error scraping chapter ${url}: ${error.message}`);
      return null;
    }
  }

  async downloadCover(url, mangaTitle = null) {
    try {
      // Get manga details to obtain cover URL
      const mangaDetails = await this.scrape(url);
      
      if (!mangaDetails || !mangaDetails.coverImage) {
        logger.warn('Cover URL not found');
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
      
      // Download cover
      try {
        const headers = {
          'User-Agent': this._getRandomUserAgent(),
          'Referer': url,
          'Accept': 'image/webp,*/*'
        };
        
        const response = await axios.get(coverUrl, {
          headers,
          responseType: 'arraybuffer',
          timeout: 30000
        });
        
        // Verify content type
        const contentType = response.headers['content-type'] || '';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Response is not an image: ${contentType}`);
        }
        
        // Save image
        fs.writeFileSync(outputFilename, response.data);
        
      } catch (e) {
        logger.warn(`Failed to download cover with axios: ${e.message}`);
        // Try with Selenium as a fallback
        await browserService.downloadImage(coverUrl, outputFilename);
      }
      
      logger.info(`Cover downloaded successfully: ${outputFilename}`);
      return outputFilename;
    } catch (error) {
      logger.error(`Error downloading cover: ${error.message}`);
      return null;
    }
  }
}

module.exports = BatoScraper;