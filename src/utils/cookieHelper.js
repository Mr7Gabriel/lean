const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class CookieHelper {
  constructor() {
    this.cookiesPath = path.join(process.cwd(), 'data', 'cookies');
    
    // Create necessary directories
    if (!fs.existsSync(this.cookiesPath)) {
      fs.mkdirSync(this.cookiesPath, { recursive: true });
    }
  }

  /**
   * Save cookies to a file for a specific domain
   * @param {string} domain - Domain to save cookies for
   * @param {Array} cookies - Array of cookie objects
   * @returns {boolean} - True if saved successfully
   */
  saveCookiesForDomain(domain, cookies) {
    try {
      if (!domain || !cookies || !Array.isArray(cookies)) {
        logger.error('Invalid domain or cookies');
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
   * Get cookies for a specific domain
   * @param {string} domain - Domain to get cookies for
   * @returns {Array} - Array of cookie objects or empty array if not found
   */
  getCookiesForDomain(domain) {
    try {
      const cookieFile = path.join(this.cookiesPath, `${domain}.json`);
      
      if (!fs.existsSync(cookieFile)) {
        logger.warn(`No cookies found for domain: ${domain}`);
        return [];
      }
      
      const cookiesJson = fs.readFileSync(cookieFile, 'utf8');
      const cookies = JSON.parse(cookiesJson);
      
      logger.info(`Loaded ${cookies.length} cookies for domain: ${domain}`);
      return cookies;
    } catch (error) {
      logger.error(`Error loading cookies for domain ${domain}: ${error.message}`);
      return [];
    }
  }

  /**
   * Format cookies from Chrome/Firefox dev tools format to the format we need
   * @param {Array} browserCookies - Cookies exported from browser
   * @returns {Array} - Formatted cookies
   */
  formatBrowserCookies(browserCookies) {
    try {
      if (!browserCookies || !Array.isArray(browserCookies)) {
        return [];
      }
      
      // Format cookies to our expected format
      return browserCookies.map(cookie => {
        // Return a standardized format that works with both Selenium and direct HTTP requests
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain || cookie.Domain,
          path: cookie.path || cookie.Path || '/',
          expires: cookie.expires || cookie.Expires || -1,
          httpOnly: cookie.httpOnly || cookie.HttpOnly || false,
          secure: cookie.secure || cookie.Secure || false
        };
      });
    } catch (error) {
      logger.error(`Error formatting cookies: ${error.message}`);
      return [];
    }
  }
}

module.exports = new CookieHelper();