const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { execSync } = require('child_process');

class BrowserService {
  constructor() {
    this.browsers = {};  // Map to store browser instances
    this.downloadPath = path.join(process.cwd(), 'downloads');
    this.cookiesPath = path.join(process.cwd(), 'data', 'cookies');
    this.activeSessions = {};
    
    // Create necessary directories
    if (!fs.existsSync(this.downloadPath)) {
      fs.mkdirSync(this.downloadPath, { recursive: true });
    }
    
    if (!fs.existsSync(this.cookiesPath)) {
      fs.mkdirSync(this.cookiesPath, { recursive: true });
    }
    
    // Kill any hanging chrome processes when the service starts
    this._killChrome();
  }

  /**
   * Kill any hanging Chrome processes
   * @private
   */
  _killChrome() {
    try {
      if (process.platform === 'linux') {
        execSync('pkill -f chrome', { stdio: 'ignore' });
        execSync('pkill -f chromium', { stdio: 'ignore' });
      } else if (process.platform === 'win32') {
        execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
      } else if (process.platform === 'darwin') {
        execSync('pkill -f "Google Chrome"', { stdio: 'ignore' });
      }
      logger.info('Killed any hanging Chrome processes');
    } catch (error) {
      logger.info('No hanging Chrome processes found to kill');
    }
  }

  /**
   * Initialize a headless browser
   * @param {string} instanceId - Unique ID for this browser instance
   * @param {boolean} headless - Whether to run in headless mode
   * @returns {Promise<Browser>} Puppeteer Browser instance
   */
  async initBrowser(instanceId = 'default', headless = true) {
    // Close existing browser with this ID if it exists
    if (this.browsers[instanceId]) {
      await this.closeBrowser(instanceId);
    }

    try {
      // Launch browser with Puppeteer
      const browser = await puppeteer.launch({
        headless: headless ? 'new' : false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
        ],
        ignoreHTTPSErrors: true,
        defaultViewport: {
          width: 1920,
          height: 1080
        },
        handleSIGINT: false, // We'll handle process signals ourselves
        handleSIGTERM: false,
        handleSIGHUP: false
      });
      
      // Store browser instance
      this.browsers[instanceId] = {
        browser,
        pages: {}
      };
      
      logger.info(`Puppeteer browser initialized successfully for instance ${instanceId}`);
      return browser;
    } catch (error) {
      // Clean up failed instance
      delete this.browsers[instanceId];
      
      logger.error(`Error initializing browser: ${error.message}`);
      throw error;
    }
  }

  /**
   * Close browser instance
   * @param {string} instanceId - ID of browser to close
   * @returns {Promise<void>}
   */
  async closeBrowser(instanceId = 'default') {
    const browserInfo = this.browsers[instanceId];
    if (browserInfo && browserInfo.browser) {
      try {
        await browserInfo.browser.close();
        logger.info(`Browser ${instanceId} closed successfully`);
      } catch (error) {
        logger.error(`Error closing browser ${instanceId}: ${error.message}`);
      } finally {
        delete this.browsers[instanceId];
      }
    }
  }

  /**
   * Close all browser instances
   * @returns {Promise<void>}
   */
  async closeAllBrowsers() {
    const instanceIds = Object.keys(this.browsers);
    for (const id of instanceIds) {
      await this.closeBrowser(id);
    }
    logger.info('All browsers closed successfully');
  }

  /**
   * Get page content with cookie handling
   * @param {string} url - URL to load
   * @returns {Promise<string>} HTML content
   */
  async getPage(url) {
    // Generate a unique ID for this page request
    const requestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    try {
      // Parse domain from URL
      const domain = this._extractDomain(url);
      
      // Initialize browser in headless mode with unique ID
      const browser = await this.initBrowser(requestId, true);
      
      // Create a new page
      const page = await browser.newPage();
      
      // Set user agent
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');
      
      // Try to load cookies for this domain
      await this._loadCookiesForDomain(domain, page);
      
      // Configure request interception for better handling of resources
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        // Skip loading unnecessary resources
        if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
          request.continue();
        } else {
          request.continue();
        }
      });
      
      logger.info(`Loading URL with Puppeteer: ${url}`);
      
      // Navigate to the URL with a timeout
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      
      // Wait for body to be present
      await page.waitForSelector('body', { timeout: 10000 });
      
      // Check for Cloudflare challenge or CAPTCHA
      const pageContent = await page.content();
      
      if (
        pageContent.includes('Verify you are human') || 
        (pageContent.includes('cloudflare') && pageContent.includes('challenge')) ||
        pageContent.includes('captcha')
      ) {
        logger.warn('Cloudflare verification or CAPTCHA detected!');
        
        // Close the headless browser
        await this.closeBrowser(requestId);
        
        // Launch a verification session and throw special error
        const verificationSession = await this.launchVerificationSession(url);
        throw {
          message: 'Verification required',
          verificationUrl: `/verify?session=${verificationSession.sessionId}`,
          sessionId: verificationSession.sessionId,
          domain: domain
        };
      }
      
      // Get the page content
      const html = await page.content();
      
      // Save cookies for future use
      await this._saveCookiesForDomain(domain, page);
      
      // Close the browser
      await this.closeBrowser(requestId);
      
      return html;
    } catch (error) {
      // Clean up browser
      await this.closeBrowser(requestId);
      
      // If it's our special verification error, propagate it
      if (error.verificationUrl) {
        throw error;
      }
      
      logger.error(`Error in getPage: ${error.message}`);
      throw error;
    }
  }

  /**
   * Download image using Puppeteer
   * @param {string} imageUrl - Image URL to download
   * @param {string} outputPath - Path to save image
   * @returns {Promise<string>} Path to downloaded image
   */
  async downloadImage(imageUrl, outputPath) {
    const downloadId = `download_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    try {
      const browser = await this.initBrowser(downloadId, true);
      const page = await browser.newPage();
      
      // Navigate to image URL
      await page.goto(imageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Wait for the image to load
      await page.waitForSelector('img', { timeout: 10000 });
      
      // Take a screenshot of the image
      const imgElement = await page.$('img');
      if (imgElement) {
        await imgElement.screenshot({ path: outputPath });
      } else {
        // If no image found, take screenshot of the entire page
        await page.screenshot({ path: outputPath });
      }
      
      logger.info(`Image downloaded successfully to: ${outputPath}`);
      
      // Close the browser
      await this.closeBrowser(downloadId);
      
      return outputPath;
    } catch (error) {
      // Clean up browser
      await this.closeBrowser(downloadId);
      
      logger.error(`Error downloading image: ${error.message}`);
      throw error;
    }
  }

  /**
   * Extract domain from URL
   * @param {string} url - URL to parse
   * @returns {string} Domain name
   * @private
   */
  _extractDomain(url) {
    try {
      const urlObj = new URL(url);
      let domain = urlObj.hostname;
      
      // Remove 'www.' prefix if present
      if (domain.startsWith('www.')) {
        domain = domain.substring(4);
      }
      
      return domain;
    } catch (error) {
      logger.error(`Error extracting domain from URL: ${error.message}`);
      return '';
    }
  }

  /**
   * Generate a unique session ID
   * @returns {string} Unique ID
   * @private
   */
  _generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Save cookies for specific domain
   * @param {string} domain - Domain to save cookies for
   * @param {Page} page - Puppeteer Page instance
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async _saveCookiesForDomain(domain, page) {
    if (!page || !domain) return false;
    
    try {
      // Get cookies from the current page
      const cookies = await page.cookies();
      
      if (!cookies || cookies.length === 0) {
        logger.warn(`No cookies found for domain: ${domain}`);
        return false;
      }
      
      // Save cookies to file
      const cookieFile = path.join(this.cookiesPath, `${domain}.json`);
      fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
      
      logger.info(`Saved ${cookies.length} cookies for domain: ${domain}`);
      return true;
    } catch (error) {
      logger.error(`Error saving cookies for domain ${domain}: ${error.message}`);
      return false;
    }
  }

  /**
   * Load cookies for specific domain
   * @param {string} domain - Domain to load cookies for
   * @param {Page} page - Puppeteer Page instance
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async _loadCookiesForDomain(domain, page) {
    if (!page || !domain) return false;
    
    try {
      const cookieFile = path.join(this.cookiesPath, `${domain}.json`);
      
      // Check if cookie file exists
      if (!fs.existsSync(cookieFile)) {
        logger.warn(`No cookie file found for domain: ${domain}`);
        return false;
      }
      
      // Load cookies from file
      const cookiesJson = fs.readFileSync(cookieFile, 'utf8');
      const cookies = JSON.parse(cookiesJson);
      
      if (!cookies || cookies.length === 0) {
        logger.warn(`No cookies found in file for domain: ${domain}`);
        return false;
      }
      
      // Set cookies
      await page.setCookie(...cookies);
      
      logger.info(`Loaded ${cookies.length} cookies for domain: ${domain}`);
      return true;
    } catch (error) {
      logger.error(`Error loading cookies for domain ${domain}: ${error.message}`);
      return false;
    }
  }

  /**
   * Launch a verification session with visible browser
   * @param {string} url - URL that requires verification
   * @returns {Promise<object>} Session information
   */
  async launchVerificationSession(url) {
    try {
      // Generate a session ID
      const sessionId = this._generateSessionId();
      
      // Launch a non-headless browser for verification
      const browser = await puppeteer.launch({
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--window-size=1280,800'
        ],
        defaultViewport: null // Use the full browser window
      });
      
      // Create a new page
      const page = await browser.newPage();
      
      // Set user agent
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');
      
      // Navigate to URL
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // Extract domain
      const domain = this._extractDomain(url);
      
      // Store session information
      this.activeSessions[sessionId] = {
        browser,
        page,
        url: url,
        domain: domain,
        startTime: Date.now(),
        expiresAt: Date.now() + (30 * 60 * 1000) // 30 minutes
      };
      
      logger.info(`Created verification session ${sessionId} for URL: ${url} (Domain: ${domain})`);
      
      return {
        sessionId,
        url,
        domain
      };
    } catch (error) {
      logger.error(`Error creating verification session: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get verification session status
   * @param {string} sessionId - Session ID to check
   * @returns {Promise<object>} Session status
   */
  async getVerificationSessionStatus(sessionId) {
    try {
      // Check if session exists
      if (!this.activeSessions[sessionId]) {
        throw new Error(`Verification session ${sessionId} not found`);
      }
      
      const session = this.activeSessions[sessionId];
      
      // Check if session has expired
      if (Date.now() > session.expiresAt) {
        await this.closeVerificationSession(sessionId);
        throw new Error(`Verification session ${sessionId} has expired`);
      }
      
      return {
        sessionId,
        url: session.url,
        domain: session.domain,
        startTime: session.startTime,
        expiresAt: session.expiresAt,
        remainingMinutes: Math.floor((session.expiresAt - Date.now()) / 60000)
      };
    } catch (error) {
      logger.error(`Error getting verification session status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Complete verification session and save cookies
   * @param {string} sessionId - Session ID to complete
   * @returns {Promise<object>} Completion status
   */
  async completeVerificationSession(sessionId) {
    try {
      // Check if session exists
      if (!this.activeSessions[sessionId]) {
        throw new Error(`Verification session ${sessionId} not found`);
      }
      
      const session = this.activeSessions[sessionId];
      
      // Save cookies from verification session
      const cookies = await session.page.cookies();
      
      if (!cookies || cookies.length === 0) {
        throw new Error('No cookies found in verification session');
      }
      
      // Save cookies to file
      const cookieFile = path.join(this.cookiesPath, `${session.domain}.json`);
      fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
      
      logger.info(`Saved ${cookies.length} cookies for domain: ${session.domain}`);
      
      // Close the session
      await this.closeVerificationSession(sessionId);
      
      return {
        success: true,
        message: `Verification completed successfully for ${session.domain}`,
        cookieCount: cookies.length,
        domain: session.domain
      };
    } catch (error) {
      logger.error(`Error completing verification session: ${error.message}`);
      throw error;
    }
  }

  /**
   * Close a verification session
   * @param {string} sessionId - Session ID to close
   * @returns {Promise<boolean>} Success status
   */
  async closeVerificationSession(sessionId) {
    try {
      // Check if session exists
      if (!this.activeSessions[sessionId]) {
        logger.warn(`Verification session ${sessionId} not found for closing`);
        return false;
      }
      
      const session = this.activeSessions[sessionId];
      
      // Close the browser
      try {
        await session.browser.close();
      } catch (err) {
        logger.warn(`Error closing verification browser: ${err.message}`);
      }
      
      // Remove the session
      delete this.activeSessions[sessionId];
      
      logger.info(`Closed verification session ${sessionId}`);
      return true;
    } catch (error) {
      logger.error(`Error closing verification session: ${error.message}`);
      return false;
    }
  }

  /**
   * Clean up expired verification sessions
   * @returns {Promise<number>} Number of sessions cleaned up
   */
  async cleanupExpiredSessions() {
    try {
      let cleanedCount = 0;
      const now = Date.now();
      
      for (const sessionId in this.activeSessions) {
        const session = this.activeSessions[sessionId];
        
        if (now > session.expiresAt) {
          await this.closeVerificationSession(sessionId);
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} expired verification sessions`);
      }
      
      return cleanedCount;
    } catch (error) {
      logger.error(`Error cleaning up expired sessions: ${error.message}`);
      return 0;
    }
  }
}

// Create a singleton instance
const browserService = new BrowserService();

// Add shutdown handler
process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal, closing all browser instances...');
  await browserService.closeAllBrowsers();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal, closing all browser instances...');
  await browserService.closeAllBrowsers();
  process.exit(0);
});

module.exports = browserService;