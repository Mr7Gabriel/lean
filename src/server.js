const express = require('express');
const cors = require('cors');
const { sequelize } = require('./db/models');
const config = require('./config');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

// Import routes
const authRoutes = require('./routes/auth.routes');
const mangaRoutes = require('./routes/manga.routes');
const chapterRoutes = require('./routes/chapter.routes');
const userRoutes = require('./routes/user.routes');
const scraperRoutes = require('./routes/scraper.routes');

// Initialize express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use('/api', authRoutes);
app.use('/api', mangaRoutes);
app.use('/api', chapterRoutes);
app.use('/api', userRoutes);
app.use('/api/scraper', scraperRoutes);

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

module.exports = app; // For testing