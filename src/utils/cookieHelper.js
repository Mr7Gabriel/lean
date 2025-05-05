const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const crypto = require('crypto');

class CookieHelper {
  constructor() {
    this.cookiesPath = path.join(process.cwd(), 'data', 'cookies');
    
    // Create necessary directories
    if (!fs.existsSync(this.cookiesPath)) {
      fs.mkdirSync(this.cookiesPath, { recursive: true });
    }

    // Standard user agent to use with the cookies
    this.standardUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
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

      // Check specifically for cf_clearance cookie
      let hasClearanceToken = false;
      
      // Ensure all Cloudflare cookies have the correct domain format
      // Sometimes Cloudflare requires cookies to start with a dot
      const processedCookies = cookies.map(cookie => {
        // Make a copy to avoid mutating the original
        const processedCookie = { ...cookie };
        
        // Special handling for cf_clearance cookie
        if (cookie.name === 'cf_clearance') {
          hasClearanceToken = true;
          logger.info(`Found cf_clearance token for domain ${domain}: ${cookie.value.substring(0, 10)}...`);
          
          // Ensure proper domain for this cookie
          if (!processedCookie.domain || !processedCookie.domain.startsWith('.')) {
            processedCookie.domain = domain.startsWith('.') ? domain : '.' + domain;
          }
          
          // Set required flags for Cloudflare cookies
          processedCookie.httpOnly = true;
          processedCookie.secure = true;
          
          // Extend cookie expiry for safety
          if (!processedCookie.expires || !processedCookie.expiry) {
            processedCookie.expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours
          }
        } 
        // Process Cloudflare-specific cookies
        else if (cookie.name && (
            cookie.name.startsWith('cf_') || 
            cookie.name.startsWith('__cf') || 
            cookie.name.includes('cloudflare'))) {
          
          // Ensure domain starts with dot for broad matching
          if (processedCookie.domain && !processedCookie.domain.startsWith('.')) {
            processedCookie.domain = '.' + processedCookie.domain;
          } else if (!processedCookie.domain) {
            processedCookie.domain = domain.startsWith('.') ? domain : '.' + domain;
          }
          
          // Ensure secure and httpOnly are set
          processedCookie.secure = true;
          processedCookie.httpOnly = true;
        }

        // Ensure we have path and expiry for all cookies
        if (!processedCookie.path) {
          processedCookie.path = '/';
        }

        if (!processedCookie.expires && !processedCookie.expiry) {
          processedCookie.expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours
        }
        
        return processedCookie;
      });
      
      // ENHANCEMENT: Create cf_clearance cookie if not found
      if (!hasClearanceToken) {
        logger.warn(`Cookie cf_clearance not found for domain ${domain}. Creating a synthetic one.`);
        
        // Generate a value that might work 
        // It won't function exactly like a real Cloudflare token but might help in some scenarios
        let value = '';
        try {
          // Try to find cf_chl_rc_m cookie which often exists when cf_clearance doesn't
          const cfChallengeToken = cookies.find(c => c.name === 'cf_chl_rc_m');
          if (cfChallengeToken) {
            // Use it as a base for our generated cookie
            value = `gen_${cfChallengeToken.value.substring(0, 10)}_${crypto.randomBytes(10).toString('hex')}`;
          } else {
            value = `generated_${crypto.randomBytes(20).toString('hex')}`;
          }
        } catch (e) {
          value = `generated_${Date.now().toString(36)}_${Math.random().toString(36).substring(2)}`;
        }
        
        // Create synthetic cf_clearance cookie
        const syntheticClearance = {
          name: 'cf_clearance',
          value: value,
          domain: domain.startsWith('.') ? domain : '.' + domain,
          path: '/',
          expiry: Math.floor(Date.now() / 1000) + 86400, // 24 hours
          httpOnly: true,
          secure: true,
          synthetic: true // mark as synthetic for our reference
        };
        
        processedCookies.push(syntheticClearance);
        logger.info(`Added synthetic cf_clearance cookie for domain ${domain}: ${value.substring(0, 15)}...`);
        
        // Also store the user agent used with this cookie
        this.saveUserAgentForDomain(domain, this.standardUserAgent);
      }

      // Store cookies along with metadata
      const cookieData = {
        cookies: processedCookies,
        metadata: {
          lastUpdated: new Date().toISOString(),
          hasClearanceToken: hasClearanceToken || !!processedCookies.find(c => c.synthetic),
          generatedCookie: !hasClearanceToken,
          domain: domain,
          cookieCount: processedCookies.length
        }
      };
      
      // Save processed cookies to file
      const cookieFile = path.join(this.cookiesPath, `${domain}.json`);
      fs.writeFileSync(cookieFile, JSON.stringify(cookieData, null, 2));
      
      logger.info(`Saved ${processedCookies.length} cookies for domain: ${domain}`);
      return true;
    } catch (error) {
      logger.error(`Error saving cookies for domain ${domain}: ${error.message}`);
      return false;
    }
  }

  /**
   * Store the user agent that was used with the cookies
   * This is critical for Cloudflare as the cf_clearance cookie is tied to user agent
   */
  saveUserAgentForDomain(domain, userAgent) {
    try {
      if (!domain || !userAgent) return false;
      
      const uaFile = path.join(this.cookiesPath, `${domain}_ua.txt`);
      fs.writeFileSync(uaFile, userAgent);
      logger.info(`Saved user agent for domain ${domain}`);
      return true;
    } catch (error) {
      logger.error(`Error saving user agent: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Get stored user agent for domain
   */
  getUserAgentForDomain(domain) {
    try {
      const uaFile = path.join(this.cookiesPath, `${domain}_ua.txt`);
      if (fs.existsSync(uaFile)) {
        return fs.readFileSync(uaFile, 'utf8').trim();
      }
      return this.standardUserAgent;
    } catch (error) {
      logger.warn(`Error reading user agent for domain ${domain}: ${error.message}`);
      return this.standardUserAgent;
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
      const cookieData = JSON.parse(cookiesJson);
      
      // Handle both old format (array) and new format (object with metadata)
      const cookies = Array.isArray(cookieData) ? cookieData : cookieData.cookies || [];
      
      // Check if there's a cf_clearance cookie
      const hasClearance = cookies.some(cookie => cookie.name === 'cf_clearance');
      const hasSyntheticClearance = cookies.some(cookie => cookie.name === 'cf_clearance' && cookie.synthetic);
      
      if (hasClearance) {
        if (hasSyntheticClearance) {
          logger.info(`Loaded ${cookies.length} cookies for domain: ${domain} (includes synthetic cf_clearance)`);
        } else {
          logger.info(`Loaded ${cookies.length} cookies for domain: ${domain} (includes cf_clearance)`);
        }
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
          expires: cookie.expires || cookie.Expires || Math.floor(Date.now() / 1000) + 86400,
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
      const uaFile = path.join(this.cookiesPath, `${domain}_ua.txt`);
      
      let success = false;
      
      if (fs.existsSync(cookieFile)) {
        fs.unlinkSync(cookieFile);
        success = true;
      }
      
      if (fs.existsSync(uaFile)) {
        fs.unlinkSync(uaFile);
        success = true;
      }
      
      if (success) {
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
      let hasClearance = false;
      
      newCookies.forEach(newCookie => {
        if (newCookie.name) {
          // Specific handling for Cloudflare cookies during merge
          if (newCookie.name === 'cf_clearance') {
            hasClearance = true;
            
            // Make sure domain is set correctly
            if (!newCookie.domain || !newCookie.domain.startsWith('.')) {
              newCookie.domain = domain.startsWith('.') ? domain : '.' + domain;
            }
            
            // Ensure secure and httpOnly flags
            newCookie.secure = true;
            newCookie.httpOnly = true;
            
            // Extend expiry for Cloudflare cookies
            if (!newCookie.expires && !newCookie.expiry) {
              newCookie.expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours
            }
            
            logger.info(`Merging cf_clearance cookie for ${domain}: ${newCookie.value.substring(0, 10)}...`);
          }
          else if (newCookie.name.startsWith('cf_') || 
              newCookie.name.startsWith('__cf') || 
              newCookie.name.includes('cloudflare')) {
            
            // Make sure domain is set correctly for other Cloudflare cookies
            if (!newCookie.domain || !newCookie.domain.startsWith('.')) {
              newCookie.domain = domain.startsWith('.') ? domain : '.' + domain;
            }
            
            // Ensure cookies are properly flagged
            newCookie.secure = true;
            newCookie.httpOnly = true;
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
      
      // Filter cookies that are applicable to this domain
      // and sort them with cf_clearance first for higher priority
      const sortedCookies = cookies
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
        .sort((a, b) => {
          // Put cf_clearance first
          if (a.name === 'cf_clearance') return -1;
          if (b.name === 'cf_clearance') return 1;
          return 0;
        });
      
      return sortedCookies
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
      
      // Get the user agent that was used with this cookie 
      // This is critical as cf_clearance only works with the same UA
      const userAgent = this.getUserAgentForDomain(domain);
      
      return {
        token: clearanceCookie.value,
        domain: clearanceCookie.domain || domain,
        expiry: clearanceCookie.expiry || clearanceCookie.expires,
        userAgent: userAgent,
        synthetic: !!clearanceCookie.synthetic
      };
    } catch (error) {
      logger.error(`Error getting Cloudflare clearance for ${domain}: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Verify Cloudflare cookies
   * Check if all required cookies are present and properly formatted
   */
  verifyCloudflareProtection(domain) {
    try {
      const cookies = this.getCookiesForDomain(domain);
      
      // Required cookies for most Cloudflare bypass scenarios
      const requiredCookies = {
        cf_clearance: false,
        __cf_bm: false,
      };
      
      // Track problematic cookies
      const issues = [];
      
      // Check for required cookies
      cookies.forEach(cookie => {
        if (cookie.name in requiredCookies) {
          requiredCookies[cookie.name] = true;
          
          // Check cookie properties
          if (!cookie.domain) {
            issues.push(`Cookie ${cookie.name} has no domain`);
          } else if (!cookie.domain.startsWith('.') && cookie.name === 'cf_clearance') {
            issues.push(`Cookie ${cookie.name} domain should start with dot: ${cookie.domain}`);
          }
          
          if (!cookie.expiry && !cookie.expires) {
            issues.push(`Cookie ${cookie.name} has no expiry`);
          }
          
          if (cookie.synthetic) {
            issues.push(`Cookie ${cookie.name} is synthetic - won't work with strict Cloudflare`);
          }
        }
      });
      
      // Add missing cookies to issues
      Object.entries(requiredCookies).forEach(([name, found]) => {
        if (!found) {
          issues.push(`Missing required cookie: ${name}`);
        }
      });
      
      const userAgent = this.getUserAgentForDomain(domain);
      if (!userAgent) {
        issues.push(`Missing User-Agent for domain ${domain}`);
      }
      
      // Return verification result
      return {
        valid: requiredCookies.cf_clearance && issues.length === 0,
        hasClearance: requiredCookies.cf_clearance,
        issues: issues,
        userAgent: userAgent,
        cookies: cookies
      };
    } catch (error) {
      logger.error(`Error verifying Cloudflare protection: ${error.message}`);
      return {
        valid: false,
        hasClearance: false,
        issues: [`Error: ${error.message}`],
        cookies: []
      };
    }
  }
}

module.exports = new CookieHelper();