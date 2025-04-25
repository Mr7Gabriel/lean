const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const UserAgent = require('user-agents');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('../config');
const logger = require('../utils/logger');
const crypto = require('crypto');

class BrowserService {
  constructor() {
    this.drivers = {};  // Map to store multiple driver instances
    this.downloadPath = path.join(process.cwd(), 'downloads');
    this.cookiesPath = path.join(process.cwd(), 'data', 'cookies');
    this.activeSessions = {};
    this.userDataDirs = new Set(); // Track active user data directories
    
    // Create necessary directories
    if (!fs.existsSync(this.downloadPath)) {
      fs.mkdirSync(this.downloadPath, { recursive: true });
    }
    
    if (!fs.existsSync(this.cookiesPath)) {
      fs.mkdirSync(this.cookiesPath, { recursive: true });
    }
  }

  /**
   * Generate a truly unique directory name
   * @param {string} prefix - Prefix for directory name
   * @returns {string} - Unique directory path
   * @private
   */
  _generateUniqueDir(prefix) {
    // Use timestamp + random bytes to ensure uniqueness
    const uniqueId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const dirPath = path.join(os.tmpdir(), `${prefix}-${uniqueId}`);
    
    // Add to tracked directories
    this.userDataDirs.add(dirPath);
    
    return dirPath;
  }

  /**
   * Initialize WebDriver with headless mode
   * @param {string} instanceId - Unique ID for this driver instance
   * @param {boolean} headless - Whether to run in headless mode
   * @returns {Promise<WebDriver>} Selenium WebDriver instance
   */
  async initDriver(instanceId = 'default', headless = true) {
    // Close existing driver with this ID if it exists
    if (this.drivers[instanceId]) {
      await this.closeDriver(instanceId);
    }

    try {
      // Generate random user agent
      const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();
      
      // Use a unique user data directory
      const userDataDir = this._generateUniqueDir('chrome-data');
      
      // Set Chrome options
      const options = new chrome.Options();
      if (headless) {
        options.addArguments('--headless=new');
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
      options.addArguments(`--user-data-dir=${userDataDir}`);
      
      // Set download preferences
      options.setUserPreferences({
        'download.default_directory': this.downloadPath,
        'download.prompt_for_download': false,
        'download.directory_upgrade': true,
        'safebrowsing.enabled': false
      });
      
      // Add custom ChromeDriver path if specified
      let service = null;
      if (config.selenium.chromeDriverPath) {
        service = new chrome.ServiceBuilder(config.selenium.chromeDriverPath).build();
      }
      
      // Build WebDriver
      const driver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .setChromeService(service)
        .build();
      
      // Store driver and its data directory
      this.drivers[instanceId] = {
        driver: driver,
        userDataDir: userDataDir
      };
      
      // Set timeouts
      await driver.manage().setTimeouts({
        implicit: 10000,
        pageLoad: 30000,
        script: 30000
      });
      
      logger.info(`Selenium WebDriver initialized successfully for instance ${instanceId}`);
      return driver;
    } catch (error) {
      // Clean up directory if driver creation failed
      const userDataDir = this.drivers[instanceId]?.userDataDir;
      if (userDataDir) {
        this.userDataDirs.delete(userDataDir);
        try {
          // We don't need to actually delete the directory, as Chrome's --user-data-dir
          // flag will create and clean them up automatically. Just remove from our tracking.
          logger.info(`Removing tracking for directory: ${userDataDir}`);
        } catch (cleanupError) {
          logger.warn(`Failed to cleanup directory: ${cleanupError.message}`);
        }
      }
      
      // Remove failed driver entry
      delete this.drivers[instanceId];
      
      logger.error(`Error initializing WebDriver: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clean up a directory safely
   * @param {string} dirPath - Directory to clean up
   * @returns {Promise<void>}
   * @private
   */
  async _cleanupDirectory(dirPath) {
    try {
      if (dirPath && fs.existsSync(dirPath)) {
        // Just log that we're "cleaning up" but don't actually try to delete
        // because Chrome handles its own user profile directories
        logger.info(`Marked directory for cleanup: ${dirPath}`);
      }
    } catch (error) {
      logger.warn(`Error with directory ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Close WebDriver
   * @param {string} instanceId - ID of driver to close
   * @returns {Promise<void>}
   */
  async closeDriver(instanceId = 'default') {
    const driverInfo = this.drivers[instanceId];
    if (driverInfo && driverInfo.driver) {
      try {
        await driverInfo.driver.quit();
        logger.info(`WebDriver ${instanceId} closed successfully`);
      } catch (error) {
        logger.error(`Error closing WebDriver ${instanceId}: ${error.message}`);
      } finally {
        // Remove from tracking
        if (driverInfo.userDataDir) {
          this.userDataDirs.delete(driverInfo.userDataDir);
        }
        delete this.drivers[instanceId];
      }
    }
  }

  /**
   * Close all WebDriver instances
   * @returns {Promise<void>}
   */
  async closeAllDrivers() {
    const instanceIds = Object.keys(this.drivers);
    for (const id of instanceIds) {
      await this.closeDriver(id);
    }
    logger.info('All WebDrivers closed successfully');
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
      
      // Initialize WebDriver in headless mode with unique ID
      const driver = await this.initDriver(requestId, true);
      
      // Try to load cookies for this domain
      await this._loadCookiesForDomain(domain, requestId);
      
      logger.info(`Loading URL with Selenium: ${url}`);
      await driver.get(url);
      
      // Wait for page to load
      await driver.wait(until.elementLocated(By.tagName('body')), 20000);
      
      // Check if page has Cloudflare challenge or other verification
      const pageSource = await driver.getPageSource();
      
      if (
        pageSource.includes('Verify you are human') || 
        (pageSource.includes('cloudflare') &&
        pageSource.includes('challenge')) ||
        pageSource.includes('captcha')
      ) {
        logger.warn('Cloudflare verification or CAPTCHA detected!');
        
        // Close the headless driver
        await this.closeDriver(requestId);
        
        // Launch a verification session and throw special error
        const verificationSession = await this.launchVerificationSession(url);
        throw {
          message: 'Verification required',
          verificationUrl: `/verify?session=${verificationSession.sessionId}`,
          sessionId: verificationSession.sessionId,
          domain: domain
        };
      }
      
      // If we reach here, no verification needed or cookies worked
      // Get the page source
      const html = await driver.getPageSource();
      
      // Save cookies for future use
      await this._saveCookiesForDomain(domain, requestId);
      
      // Clean up driver
      await this.closeDriver(requestId);
      
      return html;
    } catch (error) {
      // Clean up driver
      await this.closeDriver(requestId);
      
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
    const downloadId = `download_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    try {
      const driver = await this.initDriver(downloadId, true);
      
      // Navigate to image URL
      await driver.get(imageUrl);
      await driver.sleep(2000);
      
      // Find the image element
      const imgElement = await driver.findElement(By.tagName('img'));
      
      // Take screenshot of the image
      await imgElement.takeScreenshot(outputPath);
      
      logger.info(`Image downloaded successfully to: ${outputPath}`);
      
      // Clean up driver
      await this.closeDriver(downloadId);
      
      return outputPath;
    } catch (error) {
      // Clean up driver
      await this.closeDriver(downloadId);
      
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
   * @param {string} instanceId - WebDriver instance ID
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async _saveCookiesForDomain(domain, instanceId = 'default') {
    const driverInfo = this.drivers[instanceId];
    if (!driverInfo || !driverInfo.driver || !domain) return false;
    
    try {
      // Get cookies from the current session
      const cookies = await driverInfo.driver.manage().getCookies();
      
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
   * @param {string} instanceId - WebDriver instance ID
   * @returns {Promise<boolean>} Success status
   * @private
   */
  async _loadCookiesForDomain(domain, instanceId = 'default') {
    const driverInfo = this.drivers[instanceId];
    if (!driverInfo || !driverInfo.driver || !domain) return false;
    
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
      await driverInfo.driver.get(`https://${domain}`);
      
      // Add each cookie to the driver
      for (const cookie of cookies) {
        try {
          // Remove extra properties not supported by Selenium
          delete cookie.sameSite;
          delete cookie.storeId;
          
          // Add the cookie
          await driverInfo.driver.manage().addCookie(cookie);
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
      
      // Create unique user data directory for this session
      const userDataDir = this._generateUniqueDir('chrome-verification');
      
      // Create visible browser instance (not headless)
      const options = new chrome.Options();
      options.addArguments('--no-sandbox');
      options.addArguments('--disable-dev-shm-usage');
      options.addArguments('--disable-gpu');
      options.addArguments('--window-size=1280,800');
      options.addArguments(`--user-data-dir=${userDataDir}`);
      
      // Configure download directory
      options.setUserPreferences({
        'download.default_directory': this.downloadPath,
        'download.prompt_for_download': false,
        'download.directory_upgrade': true,
        'safebrowsing.enabled': false
      });
      
      // Create a new driver instance for verification
      let service = null;
      if (config.selenium.chromeDriverPath) {
        service = new chrome.ServiceBuilder(config.selenium.chromeDriverPath).build();
      }
      
      const verifyDriver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .setChromeService(service)
        .build();
        
      // Set timeouts
      await verifyDriver.manage().setTimeouts({
        implicit: 10000,
        pageLoad: 30000,
        script: 30000
      });
      
      // Navigate to the URL
      await verifyDriver.get(url);
      
      // Extract domain
      const domain = this._extractDomain(url);
      
      // Store session information
      this.activeSessions[sessionId] = {
        driver: verifyDriver,
        url: url,
        domain: domain,
        userDataDir: userDataDir,
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
      
      // Quit the driver
      try {
        await session.driver.quit();
      } catch (err) {
        logger.warn(`Error closing verification driver: ${err.message}`);
      }
      
      // Remove userDataDir from tracking
      if (session.userDataDir) {
        this.userDataDirs.delete(session.userDataDir);
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
  logger.info('Received SIGINT signal, closing all WebDriver instances...');
  await browserService.closeAllDrivers();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal, closing all WebDriver instances...');
  await browserService.closeAllDrivers();
  process.exit(0);
});

module.exports = browserService;