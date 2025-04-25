const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const UserAgent = require('user-agents');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

class BrowserService {
  constructor() {
    // Drivers storage
    this.drivers = {};
    
    // Paths
    this.downloadPath = path.join(process.cwd(), 'downloads');
    this.cookiesPath = path.join(process.cwd(), 'data', 'cookies');
    
    // Active verification sessions
    this.activeSessions = {};
    
    // Xvfb process and flag
    this.xvfbProcess = null;
    this.hasXvfb = false;
    
    // Create necessary directories
    this._createDirectories();
    
    // Kill hanging Chrome processes
    this._killChrome();
    
    // Start virtual display
    this._startXvfb();
  }

  /**
   * Create necessary directories
   * @private
   */
  _createDirectories() {
    const directories = [this.downloadPath, this.cookiesPath];
    
    directories.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Start Xvfb virtual display server
   * @private
   */
  _startXvfb() {
    try {
      // Check for xvfb-run
      try {
        execSync('which xvfb-run', { stdio: 'ignore' });
        logger.info('Found xvfb-run for virtual display');
        this.hasXvfb = true;
      } catch (e) {
        logger.warn('xvfb-run not found. Virtual display might not work properly.');
        
        // Attempt installation
        try {
          logger.info('Attempting to install xvfb...');
          execSync('apt-get update && apt-get install -y xvfb', { stdio: 'inherit' });
          this.hasXvfb = true;
          logger.info('Successfully installed xvfb');
        } catch (installError) {
          logger.error(`Failed to install xvfb: ${installError.message}`);
          this.hasXvfb = false;
        }
      }
      
      // Start Xvfb if available
      if (this.hasXvfb) {
        this.xvfbProcess = spawn('Xvfb', [':99', '-screen', '0', '1920x1080x24', '-ac'], {
          stdio: 'ignore',
          detached: true
        });
        
        // Set display environment
        process.env.DISPLAY = ':99';
        
        logger.info('Started Xvfb virtual display server on :99');
      }
    } catch (error) {
      logger.error(`Error starting Xvfb: ${error.message}`);
    }
  }

  /**
   * Kill hanging Chrome processes
   * @private
   */
  _killChrome() {
    const platforms = {
      linux: [
        'pkill -f chrome',
        'pkill -f chromedriver'
      ],
      win32: [
        'taskkill /F /IM chrome.exe /T',
        'taskkill /F /IM chromedriver.exe /T'
      ],
      darwin: [
        'pkill -f "Google Chrome"',
        'pkill -f chromedriver'
      ]
    };

    try {
      const platformCommands = platforms[process.platform] || [];
      platformCommands.forEach(cmd => {
        try {
          execSync(cmd, { stdio: 'ignore' });
        } catch (cmdError) {
          // Ignore errors if no processes found
        }
      });
      
      logger.info('Killed hanging Chrome processes');
    } catch (error) {
      logger.info('No hanging Chrome processes found');
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
      
      // Process cookies to ensure proper formatting
      const processedCookies = cookies.map(cookie => {
        const processedCookie = { ...cookie };
        
        // Ensure Cloudflare cookies have correct domain format
        if (cookie.name && (
          cookie.name.startsWith('cf_') || 
          cookie.name.includes('cloudflare') ||
          cookie.name.startsWith('__cf'))) {
            
          // Ensure domain begins with dot for subdomain matching
          if (processedCookie.domain && !processedCookie.domain.startsWith('.')) {
            processedCookie.domain = '.' + processedCookie.domain;
          }
          
          // Set required flags for Cloudflare cookies
          processedCookie.httpOnly = true;
          processedCookie.secure = true;
        }
        
        return processedCookie;
      });
      
      // Save cookies to file
      const cookieFile = path.join(this.cookiesPath, `${domain}.json`);
      fs.writeFileSync(cookieFile, JSON.stringify(processedCookies, null, 2));
      
      logger.info(`Saved ${processedCookies.length} cookies for domain: ${domain}`);
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
      
      // Wait for page to be ready
      await driverInfo.driver.sleep(500);
      
      // Add each cookie to the driver
      let addedCount = 0;
      
      for (const cookie of cookies) {
        try {
          // Create a clean cookie object with only the properties Selenium accepts
          const cleanCookie = {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path || '/',
            expiry: cookie.expiry || cookie.expires,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly
          };
          
          // Remove null/undefined properties
          Object.keys(cleanCookie).forEach(key => {
            if (cleanCookie[key] === undefined || cleanCookie[key] === null) {
              delete cleanCookie[key];
            }
          });
          
          // Add the cookie
          await driverInfo.driver.manage().addCookie(cleanCookie);
          addedCount++;
        } catch (err) {
          logger.warn(`Failed to add cookie ${cookie.name}: ${err.message}`);
        }
      }
      
      logger.info(`Loaded ${addedCount}/${cookies.length} cookies for domain: ${domain}`);
      
      // Refresh page to apply cookies
      await driverInfo.driver.navigate().refresh();
      await driverInfo.driver.sleep(500);
      
      return addedCount > 0;
    } catch (error) {
      logger.error(`Error loading cookies for domain ${domain}: ${error.message}`);
      return false;
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
   * Initialize WebDriver
   * @param {string} instanceId - Unique driver instance ID
   * @param {boolean} headless - Run in headless mode
   * @returns {Promise<WebDriver>} Selenium WebDriver
   */
  async initDriver(instanceId = 'default', headless = true) {
    // Close existing driver if it exists
    if (this.drivers[instanceId]) {
      await this.closeDriver(instanceId);
    }

    try {
      // Random user agent
      const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();
      
      // Chrome options
      const options = new chrome.Options();
      
      // Headless configuration
      if (headless) {
        options.addArguments('--headless=new');
      }
      
      // Common Chrome arguments
      const commonArgs = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
        `--user-agent=${userAgent}`,
        '--disable-extensions',
        '--disable-web-security',
        '--ignore-certificate-errors',
        '--allow-running-insecure-content',
        '--disable-application-cache',
        '--disable-infobars'
      ];
      
      options.addArguments(commonArgs);
      
      // Unique temp directory
      const tempDir = path.join('/tmp', `chrome-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`);
      fs.mkdirSync(tempDir, { recursive: true });
      options.addArguments(`--user-data-dir=${tempDir}`);
      
      // Download preferences
      options.setUserPreferences({
        'download.default_directory': this.downloadPath,
        'download.prompt_for_download': false,
        'download.directory_upgrade': true,
        'safebrowsing.enabled': false
      });
      
      // Custom Chrome binary path
      if (config.selenium.chromeBinaryPath) {
        options.setChromeBinaryPath(config.selenium.chromeBinaryPath);
      }
      
      // ChromeDriver service
      let service = null;
      if (config.selenium.chromeDriverPath) {
        service = new chrome.ServiceBuilder(config.selenium.chromeDriverPath).build();
      }
      
      // Build WebDriver
      const builder = new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options);
      
      if (service) {
        builder.setChromeService(service);
      }
      
      const driver = await builder.build();
      
      // Store driver info
      this.drivers[instanceId] = {
        driver,
        tempDir
      };
      
      // Set timeouts
      await driver.manage().setTimeouts({
        implicit: 10000,
        pageLoad: 30000,
        script: 30000
      });
      
      logger.info(`WebDriver initialized: ${instanceId}`);
      return driver;
    } catch (error) {
      delete this.drivers[instanceId];
      logger.error(`WebDriver init error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Initialize a reinforced WebDriver that's more resistant to detection
   * @param {string} instanceId - Unique driver instance ID
   * @param {boolean} headless - Run in headless mode
   * @returns {Promise<WebDriver>} Selenium WebDriver
   */
  async initReinforcedDriver(instanceId = 'default', headless = true) {
    // Close existing driver if it exists
    if (this.drivers[instanceId]) {
      await this.closeDriver(instanceId);
    }

    try {
      // More sophisticated user agent
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36';
      
      // Chrome options
      const options = new chrome.Options();
      
      // Headless configuration
      if (headless) {
        options.addArguments('--headless=new');
      }
      
      // Common Chrome arguments
      const commonArgs = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
        `--user-agent=${userAgent}`,
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled', // Important for avoiding detection
        '--disable-web-security',
        '--ignore-certificate-errors',
        '--allow-running-insecure-content',
        '--disable-application-cache',
        '--disable-infobars'
      ];
      
      options.addArguments(commonArgs);
      
      // Additional preferences to evade detection
      options.setUserPreferences({
        'download.default_directory': this.downloadPath,
        'download.prompt_for_download': false,
        'download.directory_upgrade': true,
        'safebrowsing.enabled': false,
        'credentials_enable_service': false,
        'profile.password_manager_enabled': false,
        'profile.default_content_setting_values.notifications': 2,
        'profile.managed_default_content_settings.images': 1,
        'profile.default_content_setting_values.cookies': 1
      });
      
      // Unique temp directory
      const tempDir = path.join('/tmp', `chrome-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`);
      fs.mkdirSync(tempDir, { recursive: true });
      options.addArguments(`--user-data-dir=${tempDir}`);
      
      // Custom Chrome binary path
      if (config.selenium.chromeBinaryPath) {
        options.setChromeBinaryPath(config.selenium.chromeBinaryPath);
      }
      
      // ChromeDriver service
      let service = null;
      if (config.selenium.chromeDriverPath) {
        service = new chrome.ServiceBuilder(config.selenium.chromeDriverPath).build();
      }
      
      // Build WebDriver
      const builder = new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options);
      
      if (service) {
        builder.setChromeService(service);
      }
      
      const driver = await builder.build();
      
      // Store driver info
      this.drivers[instanceId] = {
        driver,
        tempDir
      };
      
      // Set timeouts
      await driver.manage().setTimeouts({
        implicit: 15000,
        pageLoad: 45000,
        script: 45000
      });
      
      // Execute script to evade detection
      await driver.executeScript(`
        // Overwrite the navigator properties to mask selenium
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined
        });
        
        // Overwrite Chrome's automation property
        window.navigator.chrome = {
          runtime: {}
        };
        
        // Ensure document.hidden returns false
        Object.defineProperty(document, 'hidden', {
          get: () => false
        });
        
        // Ensure document.visibilityState returns visible
        Object.defineProperty(document, 'visibilityState', {
          get: () => 'visible'
        });
        
        // Clear the automation controller flag
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
      `);
      
      logger.info(`Reinforced WebDriver initialized: ${instanceId}`);
      return driver;
    } catch (error) {
      delete this.drivers[instanceId];
      logger.error(`WebDriver init error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Close specific WebDriver
   * @param {string} instanceId - Driver instance ID
   */
  async closeDriver(instanceId = 'default') {
    const driverInfo = this.drivers[instanceId];
    if (driverInfo && driverInfo.driver) {
      try {
        await driverInfo.driver.quit();
        
        // Clean temp directory
        if (driverInfo.tempDir && fs.existsSync(driverInfo.tempDir)) {
          fs.rmSync(driverInfo.tempDir, { recursive: true, force: true });
        }
      } catch (error) {
        logger.error(`Driver close error: ${error.message}`);
      } finally {
        delete this.drivers[instanceId];
      }
    }
  }

  /**
   * Close all WebDriver instances
   */
  async closeAllDrivers() {
    const instanceIds = Object.keys(this.drivers);
    for (const id of instanceIds) {
      await this.closeDriver(id);
    }
    
    this._killChrome();
    logger.info('All WebDrivers closed');
  }

  /**
   * Get page content
   * @param {string} url - URL to load
   * @returns {Promise<string>} HTML content
   */
  async getPage(url) {
    const requestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    try {
      const domain = this._extractDomain(url);
      const driver = await this.initReinforcedDriver(requestId, true);
      
      await this._loadCookiesForDomain(domain, requestId);
      
      logger.info(`Loading URL: ${url}`);
      await driver.get(url);
      
      // Wait for body to be present with increased timeout
      await driver.wait(until.elementLocated(By.tagName('body')), 30000);
      
      // Get page source and check for Cloudflare
      const pageSource = await driver.getPageSource();
      
      if (
        pageSource.includes('Verify you are human') || 
        (pageSource.includes('cloudflare') && pageSource.includes('challenge')) ||
        pageSource.includes('captcha') ||
        pageSource.includes('Please wait while we verify your browser')
      ) {
        logger.warn('Verification challenge detected!');
        
        await this.closeDriver(requestId);
        
        const verificationSession = await this.launchVerificationSession(url);
        
        throw {
          message: 'Verification required',
          verificationUrl: `/verify?session=${verificationSession.sessionId}`,
          sessionId: verificationSession.sessionId,
          domain: domain
        };
      }
      
      const html = await driver.getPageSource();
      
      // Save any new cookies
      await this._saveCookiesForDomain(domain, requestId);
      await this.closeDriver(requestId);
      
      return html;
    } catch (error) {
      await this.closeDriver(requestId);
      
      if (error.verificationUrl) {
        throw error;
      }
      
      logger.error(`Page load error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Download image via WebDriver
   * @param {string} imageUrl - Image URL
   * @param {string} outputPath - Save path
   * @returns {Promise<string>} Image path
   */
  async downloadImage(imageUrl, outputPath) {
    const downloadId = `download_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    try {
      const driver = await this.initDriver(downloadId, true);
      
      await driver.get(imageUrl);
      await driver.sleep(2000);
      
      const imgElement = await driver.findElement(By.tagName('img'));
      await imgElement.takeScreenshot(outputPath);
      logger.info(`Image downloaded: ${outputPath}`);
      
      await this.closeDriver(downloadId);
      
      return outputPath;
    } catch (error) {
      await this.closeDriver(downloadId);
      
      logger.error(`Image download error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Launch a verification session with visible browser
   * @param {string} url - URL that requires verification
   * @returns {Promise<object>} Session information
   */
  async launchVerificationSession(url) {
    try {
      // Make sure we have Xvfb running
      if (!this.hasXvfb) {
        logger.error('Cannot launch verification session without Xvfb');
        throw new Error('Xvfb is required for verification sessions');
      }
      
      // Generate a session ID
      const sessionId = this._generateSessionId();
      
      // Create unique temp directory
      const tempDir = path.join('/tmp', `chrome-verify-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`);
      fs.mkdirSync(tempDir, { recursive: true });
      
      // Create visible browser instance (non-headless)
      const options = new chrome.Options();
      options.addArguments('--no-sandbox');
      options.addArguments('--disable-dev-shm-usage');
      options.addArguments('--disable-gpu');
      options.addArguments('--window-size=1280,800');
      options.addArguments(`--user-data-dir=${tempDir}`);
      
      // Set Chrome binary path if provided
      if (config.selenium.chromeBinaryPath) {
        options.setChromeBinaryPath(config.selenium.chromeBinaryPath);
      }
      
      // Create a new driver instance for verification
      let service = null;
      if (config.selenium.chromeDriverPath) {
        service = new chrome.ServiceBuilder(config.selenium.chromeDriverPath).build();
      }
      
      const builder = new Builder().forBrowser('chrome').setChromeOptions(options);
      if (service) {
        builder.setChromeService(service);
      }
      
      const verifyDriver = await builder.build();
      
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
        tempDir: tempDir,
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
   * Perform remote control action on a verification session
   * @param {string} sessionId - Session ID
   * @param {object} action - Remote control action details
   * @returns {Promise<object>} Action result
   */
  async remoteControlAction(sessionId, action) {
    try {
      // Check if session exists
      if (!this.activeSessions[sessionId]) {
        throw new Error(`Verification session ${sessionId} not found`);
      }
      
      const session = this.activeSessions[sessionId];
      const driver = session.driver;
      
      // Check if session has expired
      if (Date.now() > session.expiresAt) {
        await this.closeVerificationSession(sessionId);
        throw new Error(`Verification session ${sessionId} has expired`);
      }
      
      // Perform action based on type
      switch (action.action) {
        case 'mousedown':
          await driver.actions()
            .move({ x: action.x, y: action.y })
            .press()
            .perform();
          break;
        
        case 'mouseup':
          await driver.actions()
            .move({ x: action.x, y: action.y })
            .release()
            .perform();
          break;
        
        case 'mousemove':
          await driver.actions()
            .move({ x: action.x, y: action.y })
            .perform();
          break;
        
        case 'keydown':
          await driver.actions()
            .keyDown(action.key)
            .perform();
          break;
        
        case 'keyup':
          await driver.actions()
            .keyUp(action.key)
            .perform();
          break;
        
        default:
          throw new Error(`Unsupported remote control action: ${action.action}`);
      }
      
      // Optional: Add a small delay to stabilize the browser state
      await driver.sleep(50);
      
      return { success: true };
    } catch (error) {
      logger.error(`Remote control error: ${error.message}`);
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
   * Get remote view data for a verification session
   * @param {string} sessionId - Session ID to get view for
   * @returns {Promise<object>} Remote view data
   */
  async getRemoteViewData(sessionId) {
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
      
      // Take screenshot of the current browser session
      const driver = session.driver;
      
      try {
        // Attempt to scroll to bottom and top to render full page
        await driver.executeScript('window.scrollTo(0, document.body.scrollHeight)');
        await driver.sleep(500);
        await driver.executeScript('window.scrollTo(0, 0)');
        await driver.sleep(500);
      } catch (scrollError) {
        logger.warn(`Error during page scroll: ${scrollError.message}`);
      }
      
      // Take screenshot
      const screenshot = await driver.takeScreenshot();
      
      // Determine page details
      let pageTitle = '';
      let pageUrl = '';
      
      try {
        pageTitle = await driver.getTitle();
        pageUrl = await driver.getCurrentUrl();
      } catch (detailError) {
        logger.warn(`Error getting page details: ${detailError.message}`);
      }
      
      // Return screenshot as data URL with additional metadata
      return {
        sessionId,
        screenshot: `data:image/png;base64,${screenshot}`,
        url: pageUrl || session.url,
        domain: session.domain,
        title: pageTitle,
        startTime: session.startTime,
        expiresAt: session.expiresAt,
        remainingMinutes: Math.floor((session.expiresAt - Date.now()) / 60000)
      };
    } catch (error) {
      logger.error(`Error getting remote view data: ${error.message}`);
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
      const driver = session.driver;
      const domain = session.domain;
      
      // Take a bit of time to ensure all cookies are set by Cloudflare
      await driver.sleep(1000);
      
      // Get current URL to check if we're still on a Cloudflare page
      const currentUrl = await driver.getCurrentUrl();
      const pageSource = await driver.getPageSource();
      
      // Check for Cloudflare patterns
      const stillOnCloudflare = 
        currentUrl.includes('cloudflare') || 
        pageSource.includes('Verify you are human') || 
        pageSource.includes('Cloudflare') || 
        pageSource.includes('challenge') ||
        pageSource.includes('captcha') ||
        pageSource.includes('Please wait while we verify your browser');
      
      if (stillOnCloudflare) {
        logger.warn(`Verification appears incomplete, still on Cloudflare page: ${currentUrl}`);
        return {
          success: false,
          message: "Verification appears incomplete. Please complete the Cloudflare challenge fully.",
          domain: domain
        };
      }
      
      // Save cookies from verification session
      const cookies = await driver.manage().getCookies();
      
      if (!cookies || cookies.length === 0) {
        throw new Error('No cookies found in verification session');
      }
      
      // Add some important metadata to each cookie
      const processedCookies = cookies.map(cookie => {
        const processedCookie = { ...cookie };
        
        // Ensure domain is properly set - sometimes it's missing and needs the dot prefix
        if (processedCookie.domain && !processedCookie.domain.startsWith('.') && 
            processedCookie.name && (
              processedCookie.name.startsWith('cf_') || 
              processedCookie.name.startsWith('__cf') || 
              processedCookie.name.includes('cloudflare')
            )) {
          processedCookie.domain = '.' + processedCookie.domain;
        }
        
        // Ensure httpOnly and secure are properly set for Cloudflare cookies
        if (processedCookie.name && (
            processedCookie.name.toLowerCase().includes('cf_') || 
            processedCookie.name.startsWith('__cf') || 
            processedCookie.name.includes('cloudflare'))) {
          processedCookie.httpOnly = true;
          processedCookie.secure = true;
        }
        
        return processedCookie;
      });
      
      // Save cookies to file
      const cookieFile = path.join(this.cookiesPath, `${domain}.json`);
      fs.writeFileSync(cookieFile, JSON.stringify(processedCookies, null, 2));
      
      logger.info(`Saved ${processedCookies.length} cookies for domain: ${domain}`);
      
      // Close the session
      await this.closeVerificationSession(sessionId);
      
      return {
        success: true,
        message: `Verification completed successfully for ${domain}`,
        cookieCount: processedCookies.length,
        domain: domain
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
      
      // Clean up temp directory
      if (session.tempDir && fs.existsSync(session.tempDir)) {
        try {
          fs.rmSync(session.tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
          logger.warn(`Could not clean up temp directory: ${cleanupError.message}`);
        }
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

  /**
   * Cleanup method to stop Xvfb and other resources
   */
  cleanup() {
    // Close all drivers
    this.closeAllDrivers();
    
    // Kill Xvfb process if it exists
    if (this.xvfbProcess) {
      try {
        process.kill(-this.xvfbProcess.pid);
        logger.info('Stopped Xvfb process');
      } catch (error) {
        logger.warn(`Error stopping Xvfb: ${error.message}`);
      }
    }
  }
}

// Create a singleton instance
const browserService = new BrowserService();

// Add shutdown handler
process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal, cleaning up...');
  browserService.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal, cleaning up...');
  browserService.cleanup();
  process.exit(0);
});

module.exports = browserService;