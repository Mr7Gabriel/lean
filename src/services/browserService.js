const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const UserAgent = require('user-agents');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');

class BrowserService {
  constructor() {
    this.driver = null;
    this.downloadPath = path.join(process.cwd(), 'downloads');
    
    // Create downloads directory if it doesn't exist
    if (!fs.existsSync(this.downloadPath)) {
      fs.mkdirSync(this.downloadPath, { recursive: true });
    }
  }

  async initDriver() {
    if (this.driver) {
      return this.driver;
    }

    try {
      // Generate random user agent
      const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();
      
      // Set Chrome options
      const options = new chrome.Options();
      options.addArguments('--headless');
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

  async getPage(url) {
    try {
      const driver = await this.initDriver();
      logger.info(`Loading URL with Selenium: ${url}`);
      
      await driver.get(url);
      
      // Wait for page to load
      await driver.wait(until.elementLocated(By.tagName('body')), 20000);
      
      // Check if captcha is present
      const pageSource = await driver.getPageSource();
      if (pageSource.toLowerCase().includes('captcha')) {
        logger.warn('Captcha detected! Waiting for potential manual intervention.');
        // In a real scenario, you might implement captcha solving here
        await driver.sleep(10000);
      } else {
        // Small wait for dynamic content
        await driver.sleep(3000);
      }
      
      return await driver.getPageSource();
    } catch (error) {
      logger.error(`Error in getPage: ${error.message}`);
      throw error;
    }
  }

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
}

// Singleton instance
const browserService = new BrowserService();
module.exports = browserService;