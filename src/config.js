require('dotenv').config();

module.exports = {
  // App settings
  port: process.env.PORT || 8000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Database settings
  database: {
    path: process.env.DB_PATH || './data/manga_mirror.db'
  },
  
  // JWT settings
  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },
  
  // WordPress API settings
  wordpress: {
    baseUrl: process.env.WP_BASE_URL,
    apiEndpoint: process.env.WP_API_ENDPOINT || '/api/helper/wp-manga.php',
    username: process.env.WP_API_USERNAME,
    password: process.env.WP_API_PASSWORD
  },
  
  // CDN settings
  cdn: {
    baseUrl: process.env.CDN_BASE_URL,
    apiEndpoint: process.env.CDN_API_ENDPOINT || '/api/v1/files',
    publicUrl: process.env.CDN_PUBLIC_URL
  },
  
  // Selenium settings
  selenium: {
    chromeBinaryPath: process.env.CHROME_BINARY_PATH,
    chromeDriverPath: process.env.CHROME_DRIVER_PATH
  }
};