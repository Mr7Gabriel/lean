const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const UserAgent = require('user-agents');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');
const crypto = require('crypto');

class BrowserService {
  constructor() {
    this.driver = null;
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
  }

  /**
   * Initialize WebDriver with headless mode
   * @returns {Promise<WebDriver>} Selenium WebDriver instance
   */
  async initDriver(headless = true) {
    if (this.driver) {
      return this.driver;
    }

    try {
      // Generate random user agent
      const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();
      
      // Set Chrome options
      const options = new chrome.Options();
      if (headless) {
        options.addArguments('--headless');
      }
      options.addArguments('--no-sandbox');
      options.addArguments('--disable-dev-shm-usage');
      options.addArguments('--disable-gpu');
      options.addArguments('--window-size=1920,1080');
      options.addArguments(`--user-agent=${userAgent}`);
      options.addArguments('--disable-extensions');
      options.addArguments('--disable-web-security');
      options.addArguments('--ignore-certificate-errors');
      options.addArguments('--allow-insecure-localhost');
      
      // Set download preferences
      options.setUserPreferences({
        'download.default_directory': this.downloadPath,
        'download.prompt_for_download': false,
        'download.directory_upgrade': true,
        'safebrowsing.enabled': false
      });
      
      // Add custom ChromeDriver path if specified
      if (config.selenium.chromeDriverPath) {
        const service = new chrome.ServiceBuilder(config.selenium.chromeDriverPath).build();
        chrome.setDefaultService(service);
      }
      
      // Build WebDriver
      this.driver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .build();
      
      // Set timeouts
      await this.driver.manage().setTimeouts({
        implicit: 10000,
        pageLoad: 30000,
        script: 30000
      });
      
      logger.info('Selenium WebDriver initialized successfully');
      return this.driver;
    } catch (error) {
      logger.error(`Error initializing WebDriver: ${error.message}`);
      throw error;
    }
  }

  /**
   * Close WebDriver
   * @returns {Promise<void>}
   */
  async closeDriver() {
    if (this.driver) {
      try {
        await this.driver.quit();
        this.driver = null;
        logger.info('WebDriver closed successfully');
      } catch (error) {
        logger.error(`Error closing WebDriver: ${error.message}`);
      }
    }
  }

  /**
   * Get page content with cookie handling
   * @param {string} url - URL to load
   * @returns {Promise<string>} HTML content
   */
  async getPage(url) {
    try {
      // Parse domain from URL
      const domain = this._extractDomain(url);
      
      // Try to load cookies for this domain
      const cookiesLoaded = await this._loadCookiesForDomain(domain);
      
      // Initialize WebDriver in headless mode
      const driver = await this.initDriver(true);
      
      logger.info(`Loading URL with Selenium: ${url}`);
      await driver.get(url);
      
      // Wait for page to load
      await driver.wait(until.elementLocated(By.tagName('body')), 20000);
      
      // Check if page has Cloudflare challenge or other verification
      const pageSource = await driver.getPageSource();
      
      if (
        pageSource.includes('Verify you are human') || 
        pageSource.includes('cloudflare') &&
        pageSource.includes('challenge') ||
        pageSource.includes('captcha')
      ) {
        logger.warn('Cloudflare verification or CAPTCHA detected!');
        
        // If we already tried with cookies but still get verification, 
        // we need manual intervention
        if (cookiesLoaded) {
          logger.warn('Cookies did not help with verification, manual intervention needed');
          
          // Close the headless driver
          await this.closeDriver();
          
          // Launch a verification session and throw special error
          const verificationSession = await this.launchVerificationSession(url);
          throw {
            message: 'Verification required',
            verificationUrl: `/api/verify/${verificationSession.sessionId}`,
            sessionId: verificationSession.sessionId
          };
        } else {
          logger.warn('No cookies found, will attempt manual verification');
          
          // Close the headless driver
          await this.closeDriver();
          
          // Launch a verification session and throw special error
          const verificationSession = await this.launchVerificationSession(url);
          throw {
            message: 'Verification required',
            verificationUrl: `/api/verify/${verificationSession.sessionId}`,
            sessionId: verificationSession.sessionId
          };
        }
      }
      
      // If we reach here, no verification needed or cookies worked
      // Get the page source
      const html = await driver.getPageSource();
      
      // Save cookies for future use
      await this._saveCookiesForDomain(domain);
      
      return html;
    } catch (error) {
      // If it's our special verification error, propagate it
      if (error.verificationUrl) {
        throw error;
      }
      
      logger.error(`Error in getPage: ${error.message}`);
      throw error;
    }
  }

  /**
   * Download image using WebDriver
   * @param {string} imageUrl - Image URL to download
   * @param {string} outputPath - Path to save image
   * @returns {Promise<string>} Path to downloaded image
   */
  async downloadImage(imageUrl, outputPath) {
    try {
      const driver = await this.initDriver();
      
      // Navigate to image URL
      await driver.get(imageUrl);
      await driver.sleep(2000);
      
      // Find the image element
      const imgElement = await driver.findElement(By.tagName('img'));
      
      // Take screenshot of the image
      await imgElement.takeScreenshot(outputPath);
      
      logger.info(`Image downloaded successfully to: ${outputPath}`);
      return outputPath;
    } catch (error) {
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
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async _saveCookiesForDomain(domain) {
    if (!this.driver || !domain) return false;
    
    try {
      // Get cookies from the current session
      const cookies = await this.driver.manage().getCookies();
      
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
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async _loadCookiesForDomain(domain) {
    if (!this.driver || !domain) return false;
    
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
      
      // First navigate to the domain to ensure cookies can be set
      await this.driver.get(`https://${domain}`);
      
      // Add each cookie to the driver
      for (const cookie of cookies) {
        try {
          // Remove extra properties not supported by Selenium
          delete cookie.sameSite;
          delete cookie.storeId;
          
          // Add the cookie
          await this.driver.manage().addCookie(cookie);
        } catch (err) {
          logger.warn(`Failed to add cookie: ${err.message}`);
        }
      }
      
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
      
      // Create visible browser instance (not headless)
      const options = new chrome.Options();
      options.addArguments('--no-sandbox');
      options.addArguments('--disable-dev-shm-usage');
      options.addArguments('--disable-gpu');
      options.addArguments('--window-size=1280,800');
      
      // Configure download directory
      options.setUserPreferences({
        'download.default_directory': this.downloadPath,
        'download.prompt_for_download': false,
        'download.directory_upgrade': true,
        'safebrowsing.enabled': false
      });
      
      // Create a new driver instance for verification
      const verifyDriver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .build();
        
      // Set timeouts
      await verifyDriver.manage().setTimeouts({
        implicit: 10000,
        pageLoad: 30000,
        script: 30000
      });
      
      // Navigate to the URL
      await verifyDriver.get(url);
      
      // Store session information
      this.activeSessions[sessionId] = {
        driver: verifyDriver,
        url: url,
        domain: this._extractDomain(url),
        startTime: Date.now(),
        expiresAt: Date.now() + (30 * 60 * 1000) // 30 minutes
      };
      
      logger.info(`Created verification session ${sessionId} for URL: ${url}`);
      
      return {
        sessionId,
        url
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
      const cookies = await session.driver.manage().getCookies();
      
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
        cookieCount: cookies.length
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
      
      // Quit the driver
      try {
        await session.driver.quit();
      } catch (err) {
        logger.warn(`Error closing verification driver: ${err.message}`);
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
module.exports = browserService;