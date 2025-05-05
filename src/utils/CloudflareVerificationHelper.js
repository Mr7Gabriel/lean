/**
 * CloudflareVerificationHelper.js
 * Advanced utility functions to help with Cloudflare verification and cookie management.
 * Place this file in your src/utils/ directory.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const cookieHelper = require('./cookieHelper');
const logger = require('./logger');

class CloudflareVerificationHelper {
  constructor() {
    this.cookiesPath = path.join(process.cwd(), 'data', 'cookies');
    this.standardUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
  }

  /**
   * Extract and parse Cloudflare script to understand challenge parameters
   * @param {string} html - HTML content from Cloudflare page
   * @returns {object} - Challenge parameters
   */
  extractChallengeParams(html) {
    try {
      const params = {
        rayId: '',
        siteKey: '',
        chlType: '',
        hasScript: false
      };

      // Extract ray ID
      const rayMatch = html.match(/Ray ID: ([a-z0-9]+)/i);
      if (rayMatch) {
        params.rayId = rayMatch[1];
      }

      // Check for CAPTCHA
      if (html.includes('cf-captcha-container') || html.includes('hcaptcha')) {
        params.chlType = 'captcha';
      } 
      // Check for JavaScript challenge
      else if (html.includes('jschl-answer') || html.includes('cf_chl_opt')) {
        params.chlType = 'jschallenge';
      }
      // Check for browser check
      else if (html.includes('cf-browser-verification') || html.includes('cf-im-under-attack')) {
        params.chlType = 'browser_check';
      }

      // Extract site key for CAPTCHA
      const siteKeyMatch = html.match(/sitekey="([^"]+)"/);
      if (siteKeyMatch) {
        params.siteKey = siteKeyMatch[1];
      }

      // Check for challenge script
      params.hasScript = html.includes('cf-please-wait') || 
                       html.includes('cf_chl_') || 
                       html.includes('jschl-answer');

      return params;
    } catch (error) {
      logger.error(`Error extracting challenge params: ${error.message}`);
      return {
        rayId: '',
        siteKey: '',
        chlType: 'unknown',
        hasScript: false
      };
    }
  }

  /**
   * Get status report for a domain, checking all Cloudflare mitigations
   * @param {string} domain - Domain to check
   * @returns {Promise<object>} - Status report
   */
  async getCloudflareStatus(domain) {
    try {
      const report = {
        domain: domain,
        hasCfClearance: false,
        hasCfBm: false,
        cookieCount: 0,
        userAgentSaved: false,
        lastChecked: new Date().toISOString(),
        browserTest: null
      };

      // Check cookie status
      const cookies = cookieHelper.getCookiesForDomain(domain);
      report.cookieCount = cookies.length;

      // Check for critical cookies
      report.hasCfClearance = cookies.some(c => c.name === 'cf_clearance');
      report.hasCfBm = cookies.some(c => c.name === '__cf_bm');

      // Check user agent
      const userAgent = cookieHelper.getUserAgentForDomain(domain);
      report.userAgentSaved = !!userAgent;

      // Test browser request
      try {
        const url = `https://${domain}`;
        const cookieHeader = cookieHelper.exportCookieHeader(domain);

        const response = await axios.get(url, {
          headers: {
            'User-Agent': userAgent || this.standardUserAgent,
            'Cookie': cookieHeader,
            'Accept': 'text/html,application/xhtml+xml,application/xml',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          timeout: 10000,
          validateStatus: status => true // Accept any status code
        });

        report.browserTest = {
          status: response.status,
          success: response.status === 200,
          size: response.data?.length || 0,
          cloudflareDetected: 
            response.data?.includes('Cloudflare') ||
            response.data?.includes('captcha') ||
            response.data?.includes('challenge') ||
            response.data?.includes('Verify you are human'),
          headers: response.headers
        };
      } catch (error) {
        report.browserTest = {
          status: -1,
          success: false,
          error: error.message
        };
      }

      return report;
    } catch (error) {
      logger.error(`Error getting Cloudflare status: ${error.message}`);
      return {
        domain,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Try to fix common Cloudflare cookie issues
   * @param {string} domain - Domain to fix cookies for
   * @returns {Promise<object>} - Result of fix operation
   */
  async fixCloudflareCookies(domain) {
    try {
      const cookies = cookieHelper.getCookiesForDomain(domain);
      let fixes = [];
      let fixed = false;

      // Issues to fix:
      // 1. Missing or malformed cf_clearance
      // 2. Incorrect domain format (.example.com vs example.com)
      // 3. Missing expiry 
      // 4. Missing httpOnly/secure flags

      let hasClearance = false;
      let needsSave = false;

      // Process existing cookies
      const processedCookies = cookies.map(cookie => {
        const orig = { ...cookie };
        let cookieFixed = false;

        if (cookie.name === 'cf_clearance') {
          hasClearance = true;

          // Fix domain if not starting with dot
          if (cookie.domain && !cookie.domain.startsWith('.')) {
            cookie.domain = '.' + cookie.domain;
            fixes.push(`Fixed cf_clearance domain: ${orig.domain} -> ${cookie.domain}`);
            cookieFixed = true;
          }

          // Fix missing domain
          if (!cookie.domain) {
            cookie.domain = domain.startsWith('.') ? domain : '.' + domain;
            fixes.push(`Added domain to cf_clearance: ${cookie.domain}`);
            cookieFixed = true;
          }

          // Ensure secure and httpOnly flags
          if (!cookie.secure) {
            cookie.secure = true;
            fixes.push('Added secure flag to cf_clearance');
            cookieFixed = true;
          }

          if (!cookie.httpOnly) {
            cookie.httpOnly = true;
            fixes.push('Added httpOnly flag to cf_clearance');
            cookieFixed = true;
          }

          // Fix expiry if missing
          if (!cookie.expiry && !cookie.expires) {
            cookie.expiry = Math.floor(Date.now() / 1000) + 86400;
            fixes.push('Added missing expiry to cf_clearance');
            cookieFixed = true;
          }

          // Remove synthetic flag if it exists
          if (cookie.synthetic) {
            delete cookie.synthetic;
            fixes.push('Removed synthetic flag from cf_clearance');
            cookieFixed = true;
          }

          if (cookieFixed) {
            needsSave = true;
          }
        }
        // Fix other Cloudflare cookies
        else if (cookie.name && (
            cookie.name.startsWith('cf_') || 
            cookie.name.startsWith('__cf') || 
            cookie.name.includes('cloudflare'))) {
          
          // Fix domain if not starting with dot
          if (cookie.domain && !cookie.domain.startsWith('.')) {
            cookie.domain = '.' + cookie.domain;
            fixes.push(`Fixed Cloudflare cookie ${cookie.name} domain: ${orig.domain} -> ${cookie.domain}`);
            cookieFixed = true;
          }

          // Fix missing domain
          if (!cookie.domain) {
            cookie.domain = domain.startsWith('.') ? domain : '.' + domain;
            fixes.push(`Added domain to ${cookie.name}: ${cookie.domain}`);
            cookieFixed = true;
          }

          if (cookieFixed) {
            needsSave = true;
          }
        }

        return cookie;
      });

      // Create synthetic cf_clearance if missing
      if (!hasClearance) {
        // Generate value that might work 
        const value = `fixed_${crypto.randomBytes(20).toString('hex')}`;
        
        const syntheticClearance = {
          name: 'cf_clearance',
          value: value,
          domain: domain.startsWith('.') ? domain : '.' + domain,
          path: '/',
          expiry: Math.floor(Date.now() / 1000) + 86400, // 24 hours
          httpOnly: true,
          secure: true
        };
        
        processedCookies.push(syntheticClearance);
        fixes.push('Created new synthetic cf_clearance cookie');
        needsSave = true;
      }

      // Save cookies if changes were made
      if (needsSave) {
        cookieHelper.saveCookiesForDomain(domain, processedCookies);
        fixed = true;
        logger.info(`Fixed Cloudflare cookies for ${domain}: ${fixes.join(', ')}`);
      } else {
        logger.info(`No fixes needed for Cloudflare cookies for ${domain}`);
      }

      // Make sure user agent is saved
      const userAgent = cookieHelper.getUserAgentForDomain(domain);
      if (!userAgent) {
        cookieHelper.saveUserAgentForDomain(domain, this.standardUserAgent);
        fixes.push('Saved missing user agent');
        fixed = true;
      }

      return {
        domain,
        fixed,
        fixes,
        cookieCount: processedCookies.length
      };
    } catch (error) {
      logger.error(`Error fixing Cloudflare cookies: ${error.message}`);
      return {
        domain,
        fixed: false,
        error: error.message
      };
    }
  }

  /**
   * Parse cookies from HTTP header
   * @param {string} cookieHeader - Cookie header string
   * @returns {Array} - Array of cookie objects
   */
  parseCookieHeader(cookieHeader) {
    try {
      if (!cookieHeader) return [];

      const cookies = [];
      const cookieParts = cookieHeader.split(/;\s*/);

      let currentCookie = {};

      for (const part of cookieParts) {
        // Handle name=value pair
        if (!part.includes('=')) continue;

        const [name, value] = part.split('=', 2);

        // If this is a new cookie (has no name yet), add it to the array
        if (!currentCookie.name) {
          currentCookie.name = name;
          currentCookie.value = value;
        } 
        // This is an attribute of the current cookie
        else {
          const attributeName = name.toLowerCase();
          
          switch (attributeName) {
            case 'path':
              currentCookie.path = value;
              break;
            case 'domain':
              currentCookie.domain = value;
              break;
            case 'expires':
              try {
                const date = new Date(value);
                currentCookie.expires = Math.floor(date.getTime() / 1000);
              } catch (e) {
                // Ignore invalid dates
              }
              break;
            case 'max-age':
              currentCookie.expiry = Math.floor(Date.now() / 1000) + parseInt(value, 10);
              break;
            case 'secure':
              currentCookie.secure = true;
              break;
            case 'httponly':
              currentCookie.httpOnly = true;
              break;
            case 'samesite':
              currentCookie.sameSite = value;
              break;
          }
        }

        // If we've reached a semicolon, this cookie is complete
        if (part.endsWith(';')) {
          cookies.push(currentCookie);
          currentCookie = {};
        }
      }

      // Add the last cookie if any
      if (currentCookie.name) {
        cookies.push(currentCookie);
      }

      return cookies;
    } catch (error) {
      logger.error(`Error parsing cookie header: ${error.message}`);
      return [];
    }
  }

  /**
   * Attempt to extract and save cookies from Cloudflare response headers
   * @param {string} domain - Domain of the cookies
   * @param {object} headers - Response headers object
   * @returns {boolean} - Success status
   */
  extractAndSaveCookiesFromHeaders(domain, headers) {
    try {
      if (!headers || !domain) return false;

      // Get Set-Cookie headers
      const setCookieHeaders = headers['set-cookie'] || [];
      if (!setCookieHeaders.length) return false;

      const cookies = [];
      
      // Parse each Set-Cookie header
      for (const header of setCookieHeaders) {
        const parts = header.split(';');
        const nameValue = parts[0].split('=');
        
        if (nameValue.length < 2) continue;
        
        const name = nameValue[0].trim();
        const value = nameValue[1].trim();
        
        const cookie = {
          name: name,
          value: value,
          domain: domain.startsWith('.') ? domain : '.' + domain,
          path: '/'
        };
        
        // Parse cookie attributes
        for (let i = 1; i < parts.length; i++) {
          const part = parts[i].trim().toLowerCase();
          
          if (part.startsWith('expires=')) {
            const date = new Date(part.substring(8));
            cookie.expires = Math.floor(date.getTime() / 1000);
          } 
          else if (part.startsWith('max-age=')) {
            const maxAge = parseInt(part.substring(8), 10);
            cookie.expiry = Math.floor(Date.now() / 1000) + maxAge;
          }
          else if (part.startsWith('path=')) {
            cookie.path = part.substring(5);
          }
          else if (part.startsWith('domain=')) {
            cookie.domain = part.substring(7);
            // Ensure domain starts with dot for broader matching
            if (!cookie.domain.startsWith('.')) {
              cookie.domain = '.' + cookie.domain;
            }
          }
          else if (part === 'secure') {
            cookie.secure = true;
          }
          else if (part === 'httponly') {
            cookie.httpOnly = true;
          }
        }
        
        // For Cloudflare cookies, ensure secure and httpOnly
        if (name === 'cf_clearance' || name.startsWith('cf_') || name.startsWith('__cf')) {
          cookie.secure = true;
          cookie.httpOnly = true;
          
          // Ensure domain format
          if (!cookie.domain.startsWith('.')) {
            cookie.domain = cookie.domain ? '.' + cookie.domain : 
                                          domain.startsWith('.') ? domain : '.' + domain;
          }
          
          // Set expiry if not present
          if (!cookie.expires && !cookie.expiry) {
            cookie.expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours
          }
        }
        
        cookies.push(cookie);
      }
      
      if (cookies.length > 0) {
        // Merge with existing cookies
        cookieHelper.mergeCookiesForDomain(domain, cookies);
        logger.info(`Extracted ${cookies.length} cookies from headers for domain ${domain}`);
        return true;
      }
      
      return false;
    } catch (error) {
      logger.error(`Error extracting cookies from headers: ${error.message}`);
      return false;
    }
  }
}

// Create a singleton instance
const cloudflareHelper = new CloudflareVerificationHelper();

// Export the singleton
module.exports = cloudflareHelper;