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

      // Ensure all Cloudflare cookies have the correct domain format
      // Sometimes Cloudflare requires cookies to start with a dot
      const processedCookies = cookies.map(cookie => {
        // Make a copy to avoid mutating the original
        const processedCookie = { ...cookie };
        
        // Process Cloudflare-specific cookies
        if (cookie.name && (
            cookie.name.startsWith('cf_') || 
            cookie.name.startsWith('__cf') || 
            cookie.name.includes('cloudflare'))) {
          
          // Ensure domain starts with dot unless it's an exact domain match
          if (cookie.domain && !cookie.domain.startsWith('.') && !cookie.domain.includes(domain)) {
            processedCookie.domain = '.' + cookie.domain;
          }
          
          // Ensure secure and httpOnly are set
          processedCookie.secure = true;
          processedCookie.httpOnly = true;
        }
        
        return processedCookie;
      });
      
      // Save processed cookies to file
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
        const formattedCookie = {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain || cookie.Domain,
          path: cookie.path || cookie.Path || '/',
          expires: cookie.expires || cookie.Expires || -1,
          httpOnly: cookie.httpOnly || cookie.HttpOnly || false,
          secure: cookie.secure || cookie.Secure || false
        };
        
        // Process Cloudflare-specific cookies
        if (formattedCookie.name && (
            formattedCookie.name.startsWith('cf_') || 
            formattedCookie.name.startsWith('__cf') || 
            formattedCookie.name.includes('cloudflare'))) {
          
          // Ensure domain starts with dot for broader matching
          if (formattedCookie.domain && !formattedCookie.domain.startsWith('.')) {
            formattedCookie.domain = '.' + formattedCookie.domain;
          }
          
          // Ensure secure and httpOnly are set
          formattedCookie.secure = true;
          formattedCookie.httpOnly = true;
        }
        
        return formattedCookie;
      });
    } catch (error) {
      logger.error(`Error formatting cookies: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Clear cookies for a specific domain
   * @param {string} domain - Domain to clear cookies for
   * @returns {boolean} - True if cleared successfully
   */
  clearCookiesForDomain(domain) {
    try {
      const cookieFile = path.join(this.cookiesPath, `${domain}.json`);
      
      if (fs.existsSync(cookieFile)) {
        fs.unlinkSync(cookieFile);
        logger.info(`Cleared cookies for domain: ${domain}`);
        return true;
      }
      
      logger.warn(`No cookies found to clear for domain: ${domain}`);
      return false;
    } catch (error) {
      logger.error(`Error clearing cookies for domain ${domain}: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Merge new cookies with existing cookies
   * @param {string} domain - Domain for the cookies
   * @param {Array} newCookies - New cookies to merge
   * @returns {boolean} - True if merged successfully
   */
  mergeCookiesForDomain(domain, newCookies) {
    try {
      // Get existing cookies
      const existingCookies = this.getCookiesForDomain(domain);
      
      if (!newCookies || !Array.isArray(newCookies) || newCookies.length === 0) {
        logger.warn('No new cookies to merge');
        return false;
      }
      
      // Create a map of existing cookies by name
      const cookieMap = {};
      existingCookies.forEach(cookie => {
        cookieMap[cookie.name] = cookie;
      });
      
      // Merge or add new cookies
      newCookies.forEach(newCookie => {
        if (newCookie.name) {
          cookieMap[newCookie.name] = newCookie;
        }
      });
      
      // Convert the map back to an array
      const mergedCookies = Object.values(cookieMap);
      
      // Save the merged cookies
      return this.saveCookiesForDomain(domain, mergedCookies);
    } catch (error) {
      logger.error(`Error merging cookies for domain ${domain}: ${error.message}`);
      return false;
    }
  }
}

module.exports = new CookieHelper();