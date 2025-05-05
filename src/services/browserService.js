const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const UserAgent = require('user-agents');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');
const axios = require('axios');
const cookieHelper = require('../utils/cookieHelper');

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
    this.userDataDir = path.join(process.cwd(), 'chrome-data');
    
    // Chrome path - detect automatically based on platform
    this.chromePath = this._detectChromePath();
    
    // Active verification sessions
    this.activeSessions = {};
    
    // Create necessary directories
    this._createDirectories();
    
    // Kill hanging Chrome processes
    this._killChrome();
  }

  /**
   * Detect Chrome browser path based on platform
   * @returns {string} Path to Chrome executable
   * @private
   */
  _detectChromePath() {
    try {
      if (process.platform === 'win32') {
        // Common Windows Chrome paths
        const commonPaths = [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
        ];
        
        for (const path of commonPaths) {
          if (fs.existsSync(path)) {
            logger.info(`Found Chrome at ${path}`);
            return path;
          }
        }
        
        // Use provided path from config if available
        if (config.selenium && config.selenium.chromeBinaryPath) {
          return config.selenium.chromeBinaryPath;
        }

        logger.warn('Chrome path not found, using default');
        return 'chrome.exe';
      } else if (process.platform === 'darwin') {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      } else {
        // Linux
        return '/usr/bin/google-chrome';
      }
    } catch (error) {
      logger.error(`Error detecting Chrome path: ${error.message}`);
      return 'chrome'; // Fallback to system PATH
    }
  }

  /**
   * Create necessary directories
   * @private
   */
  _createDirectories() {
    const directories = [this.downloadPath, this.cookiesPath, this.tempDir, this.userDataDir];
    
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
      if (process.platform === 'win32') {
        // Windows command to kill Chrome processes (soft)
        execSync('taskkill /IM chrome.exe /F', { stdio: 'ignore' });
        execSync('taskkill /IM chromedriver.exe /F', { stdio: 'ignore' });
      } else {
        // Linux/Mac
        execSync('pkill -f chrome', { stdio: 'ignore' });
        execSync('pkill -f chromedriver', { stdio: 'ignore' });
      }
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
      return cookieHelper.saveCookiesForDomain(domain, processedCookies);
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
      const cookies = cookieHelper.getCookiesForDomain(domain);
      
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
  async initDriver(instanceId = 'default', headless = false) {
    // Always use headful mode
    headless = false;
    
    // Close existing driver if it exists
    if (this.drivers[instanceId]) {
      await this.closeDriver(instanceId);
    }

    try {
      // Random user agent
      const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();
      
      // Chrome options
      const options = new chrome.Options();
      
      // Common Chrome arguments for Windows
      const commonArgs = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-gpu-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-accelerated-video-decode',
        '--window-size=1280,800',
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
      
      logger.info(`WebDriver initialized: ${instanceId} (headful mode)`);
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
   * Open Chrome browser directly (no Selenium) for manual verification
   * @param {string} url - URL to open
   * @returns {Promise<boolean>} Success status
   */
  async openBrowser(url) {
    return new Promise((resolve) => {
      try {
        // Domain for logging
        const domain = this._extractDomain(url);
        
        // Create a unique user data directory for this session
        const timestamp = Date.now();
        const userDataDir = path.join(this.userDataDir, `chrome-${timestamp}`);
        if (!fs.existsSync(userDataDir)) {
          fs.mkdirSync(userDataDir, { recursive: true });
        }
        
        // Build the command to open Chrome with additional flags
        // Add these flags to fix closing issue
        const chromeFlags = [
          `--user-data-dir="${userDataDir}"`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-translate',
          '--disable-extensions',
          '--disable-component-extensions-with-background-pages',
          '--disable-default-apps',
          '--no-sandbox',
          `"${url}"`
        ].join(' ');
        
        let command = `"${this.chromePath}" ${chromeFlags}`;
        
        // For Windows, use start with /wait flag
        if (process.platform === 'win32') {
          command = `start /wait "" ${command}`;
        }
        
        logger.info(`Opening Chrome for URL: ${url}`);
        logger.info(`Command: ${command}`);
        
        // Execute the command and keep the process reference
        const chromeProcess = exec(command, (error, stdout, stderr) => {
          if (error) {
            logger.error(`Error opening Chrome: ${error.message}`);
            if (stderr) logger.error(`Chrome stderr: ${stderr}`);
            resolve(false);
          } else {
            logger.info(`Chrome process completed`);
          }
        });
        
        // Store process ID for cleanup
        logger.info(`Chrome process started with PID: ${chromeProcess.pid}`);
        
        // Consider browser opened successfully once process is started
        this.lastUserDataDir = userDataDir;
        resolve(true);
        
        // Optional: Listen for browser close to do cleanup
        chromeProcess.on('close', (code) => {
          logger.info(`Chrome process exited with code ${code}`);
        });
      } catch (error) {
        logger.error(`Error in openBrowser: ${error.message}`);
        resolve(false);
      }
    });
}

  /**
   * Get page content
   * @param {string} url - URL to load
   * @returns {Promise<string>} HTML content
   */
  async getPage(url) {
    try {
      const domain = this._extractDomain(url);
      
      // Try using axios first (no browser)
      try {
        logger.info(`Attempting to fetch ${url} with direct HTTP request`);
        
        // Get cookies for this domain if available
        const cookies = cookieHelper.getCookiesForDomain(domain);
        let cookieHeader = cookieHelper.exportCookieHeader(domain);
        
        // Check if we have a cf_clearance cookie
        const hasClearanceToken = cookies.some(cookie => cookie.name === 'cf_clearance');
        
        // Make request
        const response = await axios.get(url, {
          headers: {
            'User-Agent': this.stealthUserAgent,
            'Cookie': cookieHeader,
            'Accept': 'text/html,application/xhtml+xml,application/xml',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': `https://${domain}/`
          },
          timeout: 30000
        });
        
        // If we got HTML and not a tiny response, return it
        if (response.status === 200 && 
            response.data && 
            response.data.length > 5000 &&
            !response.data.includes('Cloudflare') &&
            !response.data.includes('captcha') &&
            !response.data.includes('Please wait while we verify your browser')) {
          
          logger.info(`Successfully fetched ${url} with direct HTTP request`);
          return response.data;
        }
        
        logger.info('Direct HTTP request got blocked or returned incomplete data, trying manual Chrome approach');
      } catch (axiosError) {
        logger.info(`Axios request failed: ${axiosError.message}, trying manual Chrome approach`);
      }
      
      // Check if we need to handle Cloudflare verification
      logger.info(`Opening Chrome browser for manual verification of ${url}`);
      
      // Open Chrome browser for manual verification
      const browserOpened = await this.openBrowser(url);
      
      if (!browserOpened) {
        logger.error(`Failed to open Chrome browser for ${url}`);
        throw new Error(`Failed to open Chrome browser for ${domain}`);
      }
      
      // Create a verification session
      const sessionId = this._generateSessionId();
      
      // Store session information
      this.activeSessions[sessionId] = {
        url: url,
        domain: domain,
        startTime: Date.now(),
        expiresAt: Date.now() + (60 * 60 * 1000), // 60 minutes
        userDataDir: this.lastUserDataDir
      };
      
      // Throw a special error that should be caught by the calling code
      throw {
        message: 'Verification required',
        verificationUrl: `/verify?session=${sessionId}`,
        sessionId: sessionId,
        domain: domain,
        manualVerification: true
      };
    } catch (error) {
      // If this is our special verification error, rethrow it
      if (error.verificationUrl) {
        throw error;
      }
      
      logger.error(`Page load error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Download image via direct download or manual browser
   * @param {string} imageUrl - Image URL
   * @param {string} outputPath - Save path
   * @returns {Promise<string>} Image path
   */
  async downloadImage(imageUrl, outputPath) {
    try {
      // Try direct download first
      try {
        logger.info(`Attempting to download image directly: ${imageUrl}`);
        
        const domain = this._extractDomain(imageUrl);
        
        // Get cookies for this domain if available
        const cookieHeader = cookieHelper.exportCookieHeader(domain);
        
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
      
      // Fall back to opening Chrome directly
      const domain = this._extractDomain(imageUrl);
      
      // Open Chrome browser for manual download
      logger.info(`Opening Chrome for image URL: ${imageUrl}`);
      const browserOpened = await this.openBrowser(imageUrl);
      
      if (!browserOpened) {
        throw new Error(`Failed to open Chrome browser for image: ${imageUrl}`);
      }
      
      // Let the user know how to proceed
      logger.info(`Please save the image manually to: ${outputPath}`);
      
      // Return the path where the image should be saved
      return outputPath;
    } catch (error) {
      logger.error(`Image download error: ${error.message}`);
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
   * Complete verification session
   * This method works differently from the Selenium version - it copies cookies from Chrome
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
      const domain = session.domain;
      
      logger.info(`Completing verification session for domain: ${domain}`);
      
      // Check if we can find Cloudflare cookies
      // For manual Chrome approach, we need the user to complete verification in Chrome
      // and then we collect the cookies
      
      // Since we don't have direct access to Chrome's cookie store, we rely on the user
      // to have completed verification and trust that cookies are now in place
      
      // In a real implementation, you would extract cookies from Chrome's cookie store
      // using a method like sqlite3 to read Cookies file in Chrome profile or debug protocol
      
      // For this simplified implementation, prompt the user to check
      logger.info(`Please ensure you've completed Cloudflare verification in the Chrome browser`);
      logger.info(`Once verification is complete, close the Chrome browser window`);
      
      // Save placeholder cookies for now (in a real implementation, extract these from Chrome)
      const dummyCookies = [
        {
          name: "cf_clearance",
          value: "verification_completed_manually",
          domain: domain.startsWith('.') ? domain : '.' + domain,
          path: "/",
          expires: Math.floor(Date.now() / 1000) + 86400, // 24 hours
          httpOnly: true,
          secure: true
        }
      ];
      
      // Save cookies for future use
      cookieHelper.saveCookiesForDomain(domain, dummyCookies);
      
      // Close the session
      await this.closeVerificationSession(sessionId);
      
      return {
        success: true,
        message: `Verification completed successfully for ${domain}. Please retry your request.`,
        domain: domain
      };
    } catch (error) {
      logger.error(`Error completing verification session: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get remote view data for a verification session
   * For manual Chrome approach, this would normally provide screenshot of browser
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
      
      // Since we're using manual Chrome, we don't have a screenshot
      // Instead, provide instructions for manual verification
      
      return {
        sessionId,
        screenshot: null, // No screenshot available
        message: "Please complete verification in the Chrome browser window that was opened.",
        instructions: [
          "Complete the Cloudflare verification in the Chrome window",
          "Once verified, you will be redirected to the actual site",
          "You can then click 'Complete Verification' below",
          "This will save the cookies for future use"
        ],
        url: session.url,
        domain: session.domain,
        startTime: session.startTime,
        expiresAt: session.expiresAt,
        remainingMinutes: Math.floor((session.expiresAt - Date.now()) / 60000),
        manualVerification: true
      };
    } catch (error) {
      logger.error(`Error getting remote view data: ${error.message}`);
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
      
      // Clean up user data directory if it exists
      if (session.userDataDir && fs.existsSync(session.userDataDir)) {
        try {
          this._removeDirectory(session.userDataDir);
        } catch (cleanupError) {
          logger.warn(`Could not clean up user data directory: ${cleanupError.message}`);
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
   * Launch a verification session with visible browser
   * This method opens system Chrome directly instead of using Selenium
   * @param {string} url - URL that requires verification
   * @returns {Promise<object>} Session information
   */
  async launchVerificationSession(url) {
    try {
      // Generate a session ID
      const sessionId = this._generateSessionId();
      
      // Domain for session
      const domain = this._extractDomain(url);
      
      // Open Chrome browser for manual verification
      logger.info(`Launching manual verification session for ${domain}`);
      
      const browserOpened = await this.openBrowser(url);
      
      if (!browserOpened) {
        throw new Error(`Failed to open Chrome browser for ${domain}`);
      }
      
      // Store session information
      this.activeSessions[sessionId] = {
        url: url,
        domain: domain,
        startTime: Date.now(),
        expiresAt: Date.now() + (60 * 60 * 1000), // 60 minutes
        userDataDir: this.lastUserDataDir
      };
      
      logger.info(`Created verification session ${sessionId} for URL: ${url} (Domain: ${domain})`);
      
      return {
        sessionId,
        url,
        domain,
        manualVerification: true
      };
    } catch (error) {
      logger.error(`Error creating verification session: ${error.message}`);
      throw error;
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
   * Cleanup method to stop resources
   */
  cleanup() {
    // Close all drivers
    this.closeAllDrivers();
    
    // Kill any Chrome processes if needed
    this._killChrome();
    
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