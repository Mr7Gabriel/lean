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

      // Periksa secara khusus cookie cf_clearance
      let hasClearanceToken = false;
      
      // Ensure all Cloudflare cookies have the correct domain format
      // Sometimes Cloudflare requires cookies to start with a dot
      const processedCookies = cookies.map(cookie => {
        // Make a copy to avoid mutating the original
        const processedCookie = { ...cookie };
        
        // Penanganan khusus untuk cookie cf_clearance
        if (cookie.name === 'cf_clearance') {
          hasClearanceToken = true;
          // Pastikan domain yang benar untuk cookie ini
          if (!processedCookie.domain || !processedCookie.domain.startsWith('.')) {
            processedCookie.domain = domain.startsWith('.') ? domain : '.' + domain;
          }
          
          // Pastikan cookie memiliki atribut yang benar
          processedCookie.httpOnly = true;
          processedCookie.secure = true;
          
          // Perluas masa berlaku cookie
          if (!processedCookie.expires || !processedCookie.expiry) {
            processedCookie.expiry = Math.floor(Date.now() / 1000) + 86400; // 24 jam
          }
          
          logger.info(`Cookie cf_clearance ditemukan dan diproses untuk domain ${domain}: ${processedCookie.value.substring(0, 10)}...`);
        }
        // Process Cloudflare-specific cookies
        else if (cookie.name && (
            cookie.name.startsWith('cf_') || 
            cookie.name.startsWith('__cf') || 
            cookie.name.includes('cloudflare'))) {
          
          // Ensure domain starts with dot unless it's an exact domain match
          if (cookie.domain && !cookie.domain.startsWith('.') && !cookie.domain.includes(domain)) {
            processedCookie.domain = '.' + cookie.domain;
          } else if (!cookie.domain) {
            processedCookie.domain = domain.startsWith('.') ? domain : '.' + domain;
          }
          
          // Ensure secure and httpOnly are set
          processedCookie.secure = true;
          processedCookie.httpOnly = true;
        }
        
        return processedCookie;
      });
      
      // Jika tidak ada token clearance, log peringatan
      if (!hasClearanceToken) {
        logger.warn(`Cookie cf_clearance tidak ditemukan untuk domain ${domain}. Verifikasi mungkin tidak lengkap.`);
      } else {
        logger.info(`Cookie cf_clearance ditemukan untuk domain ${domain}.`);
      }
      
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
      
      // Cek apakah ada cookie cf_clearance
      const hasClearance = cookies.some(cookie => cookie.name === 'cf_clearance');
      if (hasClearance) {
        logger.info(`Loaded ${cookies.length} cookies for domain: ${domain} (includes cf_clearance)`);
      } else {
        logger.info(`Loaded ${cookies.length} cookies for domain: ${domain} (no cf_clearance)`);
      }
      
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
          
          // Extend expiry for Cloudflare cookies
          if (formattedCookie.name === 'cf_clearance' && (!formattedCookie.expires || formattedCookie.expires < 0)) {
            formattedCookie.expires = Math.floor(Date.now() / 1000) + 86400; // 24 hours
          }
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
          // Specific handling for Cloudflare cookies during merge
          if (newCookie.name === 'cf_clearance' || 
              newCookie.name.startsWith('cf_') || 
              newCookie.name.startsWith('__cf') || 
              newCookie.name.includes('cloudflare')) {
            
            // Make sure domain is set correctly
            if (!newCookie.domain || !newCookie.domain.startsWith('.')) {
              newCookie.domain = domain.startsWith('.') ? domain : '.' + domain;
            }
            
            // Ensure secure and httpOnly flags
            newCookie.secure = true;
            newCookie.httpOnly = true;
            
            // Extend expiry for Cloudflare cookies
            if (!newCookie.expires || !newCookie.expiry) {
              newCookie.expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours
            }
            
            if (newCookie.name === 'cf_clearance') {
              logger.info(`Merging cf_clearance cookie for ${domain}: ${newCookie.value.substring(0, 10)}...`);
            }
          }
          
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

  /**
   * Export cookies for use with requests library
   * @param {string} domain - Domain to export cookies for
   * @returns {string} - Cookie header string
   */
  exportCookieHeader(domain) {
    try {
      const cookies = this.getCookiesForDomain(domain);
      if (!cookies || cookies.length === 0) {
        return '';
      }
      
      return cookies
        .filter(cookie => {
          // Only include applicable cookies
          if (!cookie.domain) return true;
          
          // Check if cookie domain matches request domain
          if (cookie.domain.startsWith('.')) {
            // .example.com matches example.com and subdomains
            return domain.includes(cookie.domain.substring(1));
          } else {
            // exact domain match
            return domain === cookie.domain;
          }
        })
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ');
    } catch (error) {
      logger.error(`Error exporting cookie header for domain ${domain}: ${error.message}`);
      return '';
    }
  }

  /**
   * Extract Cloudflare clearance token from cookies
   * @param {string} domain - Domain to check
   * @returns {object|null} - Object with token and user-agent if found
   */
  getCloudflareClearance(domain) {
    try {
      const cookies = this.getCookiesForDomain(domain);
      
      // Find the cf_clearance cookie
      const clearanceCookie = cookies.find(cookie => cookie.name === 'cf_clearance');
      
      if (!clearanceCookie) {
        return null;
      }
      
      return {
        token: clearanceCookie.value,
        domain: clearanceCookie.domain || domain,
        expiry: clearanceCookie.expiry || clearanceCookie.expires,
        // User agent is critically important for Cloudflare - should be stored alongside
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
      };
    } catch (error) {
      logger.error(`Error getting Cloudflare clearance for ${domain}: ${error.message}`);
      return null;
    }
  }
}

module.exports = new CookieHelper();