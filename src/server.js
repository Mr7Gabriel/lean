const express = require('express');
const cors = require('cors');
const path = require('path');
const { sequelize } = require('./db/models');
const config = require('./config');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const browserService = require('./services/browserService');
const cookieRoutes = require('./routes/cookie.routes');
const cloudflareHelper = require('./utils/CloudflareVerificationHelper');


// Import routes
const authRoutes = require('./routes/auth.routes');
const mangaRoutes = require('./routes/manga.routes');
const chapterRoutes = require('./routes/chapter.routes');
const userRoutes = require('./routes/user.routes');
const scraperRoutes = require('./routes/scraper.routes');
const verificationRoutes = require('./routes/verification.routes');

// Initialize express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api', authRoutes);
app.use('/api', mangaRoutes);
app.use('/api', chapterRoutes);
app.use('/api', userRoutes);
app.use('/api/scraper', scraperRoutes);
app.use('/api/verify', verificationRoutes);
app.use('/api/cookies', cookieRoutes);

// Route for verification page
app.get('/verify', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/verification.html'));
});

// Route for Cookies
app.get('/cookies', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/cookie-manager.html'));
});

// Memeriksa status Cloudflare
app.get('/api/cloudflare/status/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const status = await cloudflareHelper.getCloudflareStatus(domain);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cloudflare/fix/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const result = await cloudflareHelper.fixCloudflareCookies(domain);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      error: error.stack
    });
  }
});

// Endpoint untuk memverifikasi status Cloudflare untuk domain tertentu
app.get('/api/cloudflare/status/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const status = await cloudflareHelper.getCloudflareStatus(domain);
    res.json(status);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Endpoint untuk membersihkan cookie Cloudflare
app.delete('/api/cloudflare/cookies/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const result = cookieHelper.clearCookiesForDomain(domain);
    res.json({
      status: 'success',
      message: result ? `Cookies for ${domain} cleared successfully` : `No cookies found for ${domain}`,
      domain: domain
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Endpoint untuk mengambil cookie Cloudflare
app.get('/api/cloudflare/cookies/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const cookies = cookieHelper.getCookiesForDomain(domain);
    const userAgent = cookieHelper.getUserAgentForDomain(domain);
    
    res.json({
      status: 'success',
      domain: domain,
      cookies: cookies,
      userAgent: userAgent,
      hasClearance: cookies.some(c => c.name === 'cf_clearance'),
      cookieCount: cookies.length
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Root route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to Manga Mirror API' });
});

// Health check
app.get('/api/healthcheck', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Error handling middleware
app.use(errorHandler);

// Add cleanup job for expired verification sessions
setInterval(async () => {
  try {
    const cleanedCount = await browserService.cleanupExpiredSessions();
    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} expired verification sessions`);
    }
  } catch (error) {
    logger.error(`Error in cleanup job: ${error.message}`);
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// Start server
const PORT = config.port || 8000;

// Sync database and start server
sequelize.sync().then(() => {
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
}).catch(err => {
  logger.error(`Database connection error: ${err.message}`);
});

module.exports = app; 