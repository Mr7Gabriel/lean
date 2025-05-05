const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const UserAgent = require('user-agents');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { execSync } = require('child_process');
const axios = require('axios');

class BrowserService {
  constructor() {
    // Drivers storage
    this.drivers = {};
    
    // Set consistent User-Agent for requests
    this.stealthUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
    
    // Paths - use Windows-compatible paths
    this.downloadPath = path.join(process.cwd(), 'downloads');
    this.cookiesPath = path.join(process.cwd(), 'data', 'cookies');
    this.tempDir = path.join(process.cwd(), 'temp');
    
    // Active verification sessions
    this.activeSessions = {};
    
    // Create necessary directories
    this._createDirectories();
    
    // Kill hanging Chrome processes
    this._killChrome();
  }

  /**
   * Create necessary directories
   * @private
   */
  _createDirectories() {
    const directories = [this.downloadPath, this.cookiesPath, this.tempDir];
    
    directories.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    logger.info('Created necessary directories');
  }

  /**
   * Kill hanging Chrome processes on Windows
   * @private
   */
  _killChrome() {
    try {
      // Windows command to kill Chrome processes
      execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
      execSync('taskkill /F /IM chromedriver.exe /T', { stdio: 'ignore' });
      logger.info('Killed hanging Chrome processes');
    } catch (error) {
      // Ignore error if no processes were found
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
        
        // Special handling for Cloudflare cookies
        if (cookie.name && (
          cookie.name.startsWith('cf_') || 
          cookie.name.includes('cloudflare') ||
          cookie.name.startsWith('__cf') ||
          cookie.name === 'cf_clearance')) {
            
          // Ensure domain begins with dot for subdomain matching
          if (processedCookie.domain && !processedCookie.domain.startsWith('.')) {
            processedCookie.domain = '.' + processedCookie.domain;
          }
          
          // Ensure proper domain is set if it's missing
          if (!processedCookie.domain) {
            processedCookie.domain = domain.startsWith('.') ? domain : '.' + domain;
          }
          
          // Set required flags for Cloudflare cookies
          processedCookie.httpOnly = true;
          processedCookie.secure = true;
          
          // Extend expiry for Cloudflare cookies
          if (processedCookie.name === 'cf_clearance') {
            processedCookie.expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours
            logger.info(`Found cf_clearance cookie with value: ${processedCookie.value.substring(0, 10)}...`);
          }
        }
        
        return processedCookie;
      });
      
      // Check for cf_clearance cookie - critical for Cloudflare bypass
      const hasClearanceToken = processedCookies.some(cookie => cookie.name === 'cf_clearance');
      if (hasClearanceToken) {
        logger.info(`Found cf_clearance token for domain: ${domain}`);
      } else {
        logger.warn(`No cf_clearance token found for domain: ${domain}. Verification might fail.`);
      }
      
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
      await driverInfo.driver.sleep(1000);
      
      // Add each cookie to the driver
      let addedCount = 0;
      let addedClearance = false;
      
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
          
          // Check if this is the cf_clearance cookie
          if (cookie.name === 'cf_clearance') {
            logger.info(`Adding cf_clearance cookie: ${cookie.value.substring(0, 10)}...`);
            addedClearance = true;
          }
          
          // Add the cookie
          await driverInfo.driver.manage().addCookie(cleanCookie);
          addedCount++;
        } catch (err) {
          logger.warn(`Failed to add cookie ${cookie.name}: ${err.message}`);
        }
      }
      
      logger.info(`Loaded ${addedCount}/${cookies.length} cookies for domain: ${domain}`);
      
      if (addedClearance) {
        logger.info('Successfully added Cloudflare clearance token');
      } else {
        logger.warn('No Cloudflare clearance token was added');
      }
      
      // Refresh page to apply cookies
      await driverInfo.driver.navigate().refresh();
      await driverInfo.driver.sleep(2000);
      
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
      
      // Common Chrome arguments for Windows
      const commonArgs = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-gpu-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-accelerated-video-decode',
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
      
      // Use a Windows-friendly temp directory
      const tempDir = path.join(this.tempDir, `chrome-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      options.addArguments(`--user-data-dir=${tempDir}`);
      
      // Download preferences
      options.setUserPreferences({
        'download.default_directory': this.downloadPath,
        'download.prompt_for_download': false,
        'download.directory_upgrade': true,
        'safebrowsing.enabled': false
      });
      
      // Custom Chrome binary path if provided
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
      // Chrome options
      const options = new chrome.Options();
      
      // Headless configuration
      if (headless) {
        options.addArguments('--headless=new');
      }
      
      // Stealth arguments to avoid detection
      const stealthArgs = [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-features=BlockInsecurePrivateNetworkRequests',
        '--disable-web-security',
        '--allow-running-insecure-content',
        `--user-agent=${this.stealthUserAgent}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-gpu-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-accelerated-video-decode',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--enable-features=NetworkServiceInProcess2',
        '--disable-features=PrivacySandboxAdsAPIs',
        '--window-size=1920,1080'
      ];
      
      options.addArguments(stealthArgs);
      
      // Additional preferences to avoid detection
      options.setUserPreferences({
        'profile.default_content_setting_values.notifications': 2,
        'profile.default_content_settings.popups': 0,
        'download.prompt_for_download': false,
        'download.default_directory': this.downloadPath,
        'plugins.always_open_pdf_externally': true,
        'credentials_enable_service': false,
        'profile.password_manager_enabled': false
      });
      
      // Use a Windows-friendly temp directory
      const tempDir = path.join(this.tempDir, `chrome-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      options.addArguments(`--user-data-dir=${tempDir}`);
      
      // Custom Chrome binary path if provided
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
      
      // Add anti-detection scripts
      try {
        await driver.executeScript(`
          // Overwrite navigator properties
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined
          });
          
          // Handle notification permissions
          const originalQuery = window.navigator.permissions ? window.navigator.permissions.query : null;
          if (originalQuery) {
            window.navigator.permissions.query = (parameters) => (
              parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
            );
          }
          
          // Remove automation flags
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
          
          // Add plugins data
          Object.defineProperty(navigator, 'plugins', {
            get: () => {
              return [{
                0: {type: "application/pdf"},
                description: "Portable Document Format",
                filename: "internal-pdf-viewer",
                length: 1,
                name: "Chrome PDF Plugin"
              }];
            }
          });
          
          // Add languages
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en', 'id']
          });
          
          // Override plugin detection
          const prototypeObj = {};
          prototypeObj.toString = function toString() {
            return "[object PluginArray]";
          };
          Object.setPrototypeOf(navigator.plugins, prototypeObj);
        `);
      } catch (scriptError) {
        logger.warn(`Anti-detection script error: ${scriptError.message}`);
      }
      
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
          this._removeDirectory(driverInfo.tempDir);
        }
      } catch (error) {
        logger.error(`Driver close error: ${error.message}`);
      } finally {
        delete this.drivers[instanceId];
      }
    }
  }
  
  /**
   * Utility to recursively remove directory on Windows
   * @private
   */
  _removeDirectory(dirPath) {
    if (fs.existsSync(dirPath)) {
      fs.readdirSync(dirPath).forEach((file) => {
        const curPath = path.join(dirPath, file);
        if (fs.lstatSync(curPath).isDirectory()) {
          // Recursive call for directories
          this._removeDirectory(curPath);
        } else {
          // Delete file
          try {
            fs.unlinkSync(curPath);
          } catch (e) {
            logger.warn(`Failed to delete file ${curPath}: ${e.message}`);
          }
        }
      });
      try {
        fs.rmdirSync(dirPath);
      } catch (e) {
        logger.warn(`Failed to remove directory ${dirPath}: ${e.message}`);
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
      
      // Try using axios first (no browser)
      try {
        logger.info(`Attempting to fetch ${url} with direct HTTP request`);
        
        // Get cookies for this domain if available
        const cookieFile = path.join(this.cookiesPath, `${domain}.json`);
        let cookieHeader = '';
        
        if (fs.existsSync(cookieFile)) {
          const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
          cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
        
        // Make request
        const response = await axios.get(url, {
          headers: {
            'User-Agent': this.stealthUserAgent,
            'Cookie': cookieHeader,
            'Accept': 'text/html,application/xhtml+xml,application/xml',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          timeout: 30000
        });
        
        // If we got HTML and not a tiny response, return it
        if (response.status === 200 && 
            response.data && 
            response.data.length > 5000 &&
            !response.data.includes('Cloudflare') &&
            !response.data.includes('captcha')) {
          
          logger.info(`Successfully fetched ${url} with direct HTTP request`);
          return response.data;
        }
        
        logger.info('Direct HTTP request got blocked or returned incomplete data, falling back to browser');
      } catch (axiosError) {
        logger.info(`Axios request failed: ${axiosError.message}, falling back to browser`);
      }
      
      // Initialize browser with reinforced settings
      const driver = await this.initReinforcedDriver(requestId, true);
      
      // Load saved cookies
      await this._loadCookiesForDomain(domain, requestId);
      
      // Navigate to URL
      logger.info(`Loading URL: ${url}`);
      await driver.get(url);
      
      // Wait for body to load
      await driver.wait(until.elementLocated(By.tagName('body')), 30000);
      
      // Get page source and check for Cloudflare
      const pageSource = await driver.getPageSource();
      const currentUrl = await driver.getCurrentUrl();
      
      // Additional wait for Cloudflare redirect
      if (currentUrl.includes('cloudflare') || 
          pageSource.includes('Cloudflare') || 
          pageSource.includes('challenge')) {
        logger.info('Cloudflare page detected, waiting for possible redirect...');
        await driver.sleep(5000);
      }
      
      // Check for verification challenge
      if (
        pageSource.includes('Verify you are human') || 
        (pageSource.includes('cloudflare') && pageSource.includes('challenge')) ||
        pageSource.includes('captcha') ||
        pageSource.includes('Please wait while we verify your browser') ||
        currentUrl.includes('cloudflare')
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
      
      // Wait a bit before closing to ensure all cookies are properly set
      await driver.sleep(1000);
      
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
      // Try direct download first
      try {
        logger.info(`Attempting to download image directly: ${imageUrl}`);
        
        const domain = this._extractDomain(imageUrl);
        
        // Get cookies for this domain if available
        const cookieFile = path.join(this.cookiesPath, `${domain}.json`);
        let cookieHeader = '';
        
        if (fs.existsSync(cookieFile)) {
          const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
          cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
        
        // Make request
        const response = await axios.get(imageUrl, {
          headers: {
            'User-Agent': this.stealthUserAgent,
            'Cookie': cookieHeader,
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': `https://${domain}/`
          },
          responseType: 'arraybuffer',
          timeout: 30000
        });
        
        // Check if it's an image
        const contentType = response.headers['content-type'] || '';
        if (response.status === 200 && contentType.startsWith('image/')) {
          // Save to file
          fs.writeFileSync(outputPath, Buffer.from(response.data));
          logger.info(`Image downloaded directly: ${outputPath}`);
          return outputPath;
        }
        
        logger.info('Direct image download failed, falling back to browser');
      } catch (axiosError) {
        logger.info(`Axios image download failed: ${axiosError.message}, falling back to browser`);
      }
      
      // Fall back to browser download
      const driver = await this.initReinforcedDriver(downloadId, true);
      
      // Extract domain to load cookies
      const domain = this._extractDomain(imageUrl);
      if (domain) {
        await this._loadCookiesForDomain(domain, downloadId);
      }
      
      await driver.get(imageUrl);
      await driver.sleep(3000);
      
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
      // Generate a session ID
      const sessionId = this._generateSessionId();
      
      // Create unique temp directory
      const tempDir = path.join(this.tempDir, `chrome-verify-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Create visible browser instance (non-headless)
      const options = new chrome.Options();
      options.addArguments('--no-sandbox');
      options.addArguments('--disable-dev-shm-usage');
      options.addArguments('--disable-gpu');
      options.addArguments('--window-size=1280,800');
      options.addArguments(`--user-data-dir=${tempDir}`);
      options.addArguments(`--user-agent=${this.stealthUserAgent}`);
      
      // Add stealth options for better Cloudflare bypass
      options.addArguments('--disable-blink-features=AutomationControlled');
      
      // Set preferences for stealth
      options.setUserPreferences({
        'credentials_enable_service': false,
        'profile.password_manager_enabled': false,
        'profile.default_content_setting_values.notifications': 2
      });
      
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
      
      // Apply stealth scripts
      try {
        await verifyDriver.executeScript(`
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined
          });
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
        `);
      } catch (scriptError) {
        logger.warn(`Stealth script error: ${scriptError.message}`);
      }
      
      // Extract domain
      const domain = this._extractDomain(url);
      
      // Load existing cookies if available
      try {
        const cookieFile = path.join(this.cookiesPath, `${domain}.json`);
        if (fs.existsSync(cookieFile)) {
          // First navigate to the domain
          await verifyDriver.get(`https://${domain}`);
          await verifyDriver.sleep(1000);
          
          // Load cookies
          const cookiesJson = fs.readFileSync(cookieFile, 'utf8');
          const cookies = JSON.parse(cookiesJson);
          
          // Add cookies
          for (const cookie of cookies) {
            try {
              const cleanCookie = {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || '/',
                expiry: cookie.expiry || cookie.expires,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly
              };
              
              Object.keys(cleanCookie).forEach(key => {
                if (cleanCookie[key] === undefined || cleanCookie[key] === null) {
                  delete cleanCookie[key];
                }
              });
              
              await verifyDriver.manage().addCookie(cleanCookie);
            } catch (cookieError) {
              // Ignore cookie errors
            }
          }
          
          logger.info(`Loaded existing cookies for domain: ${domain}`);
        }
      } catch (cookieError) {
        logger.warn(`Error loading cookies: ${cookieError.message}`);
      }
      
      // Navigate to the URL
      await verifyDriver.get(url);
      
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
      
      // Wait longer after verification to give Cloudflare time to process
      await driver.sleep(5000);
      
      // Refresh page to ensure cookies are applied
      await driver.navigate().refresh();
      await driver.sleep(3000);
      
      // Check if still on Cloudflare page
      const pageSource = await driver.getPageSource();
      const currentUrl = await driver.getCurrentUrl();
      
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
      
      // Get all cookies, specifically looking for cf_clearance
      const cookies = await driver.manage().getCookies();
      let hasClearanceToken = false;
      
      // Log and process all cookies with focus on Cloudflare cookies
      const processedCookies = cookies.map(cookie => {
        const processedCookie = { ...cookie };
        
        // Check if this is a cf_clearance cookie
        if (cookie.name === 'cf_clearance') {
          hasClearanceToken = true;
          logger.info(`Found cf_clearance token: ${cookie.value.substring(0, 10)}...`);
          
          // Ensure proper domain for this cookie
          if (!cookie.domain || !cookie.domain.startsWith('.')) {
            processedCookie.domain = domain.startsWith('.') ? domain : '.' + domain;
          }
          
          // Extend cookie expiry for safety
          processedCookie.expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours
          processedCookie.httpOnly = true;
          processedCookie.secure = true;
        } else if (cookie.name && (
            cookie.name.startsWith('cf_') || 
            cookie.name.startsWith('__cf') ||
            cookie.name.includes('cloudflare'))) {
          // Ensure proper domain for other Cloudflare cookies
          if (!cookie.domain || !cookie.domain.startsWith('.')) {
            processedCookie.domain = domain.startsWith('.') ? domain : '.' + domain;
          }
          
          // Set required flags
          processedCookie.httpOnly = true;
          processedCookie.secure = true;
        }
        
        return processedCookie;
      });
      
      if (!hasClearanceToken) {
        logger.warn('cf_clearance token not found. Verification may not be complete.');
        
        // Try to determine challenge type from page
        let challengeType = "unknown";
        try {
          if (pageSource.includes('captcha')) {
            challengeType = "CAPTCHA";
          } else if (pageSource.includes('challenge')) {
            challengeType = "challenge";
          }
        } catch (e) {
          // Ignore errors in challenge type detection
        }
        
        return {
          success: false,
          message: `Verification incomplete. No cf_clearance token found. Please complete the ${challengeType} challenge and try again.`,
          domain
        };
      }
      
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
          this._removeDirectory(session.tempDir);
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
   * Check if the current page is still a Cloudflare verification page
   * @param {string} sessionId - Session ID to check
   * @returns {Promise<boolean>} True if still on Cloudflare
   */
  async isOnCloudflareVerification(sessionId) {
    try {
      // Check if session exists
      if (!this.activeSessions[sessionId]) {
        throw new Error(`Verification session ${sessionId} not found`);
      }
      
      const session = this.activeSessions[sessionId];
      const driver = session.driver;
      
      // Get current URL and page source
      const currentUrl = await driver.getCurrentUrl();
      const pageSource = await driver.getPageSource();
      
      // Check for Cloudflare patterns
      const cloudflarePatterns = [
        'Verify you are human',
        'cloudflare',
        'challenge',
        'captcha',
        'Please wait while we verify your browser'
      ];
      
      // Check if URL contains cloudflare
      if (currentUrl.includes('cloudflare')) {
        return true;
      }
      
      // Check if page source contains any Cloudflare patterns
      for (const pattern of cloudflarePatterns) {
        if (pageSource.includes(pattern)) {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      logger.error(`Error checking if on Cloudflare verification: ${error.message}`);
      return true; // Assume still on verification on error
    }
  }

  /**
   * Cleanup method to stop resources
   */
  cleanup() {
    // Close all drivers
    this.closeAllDrivers();
    
    logger.info('Browser service cleanup completed');
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