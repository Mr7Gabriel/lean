const bcrypt = require('bcrypt');
const { sequelize, User, Genre, Scraper, ScraperDomain } = require('./models');
const logger = require('../utils/logger');

// Default genres for manga
const DEFAULT_GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", 
  "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", 
  "Sports", "Supernatural", "Thriller", "Historical", "School", 
  "Ecchi", "Seinen", "Shoujo", "Shounen", "Josei", "Harem", "Isekai"
];

// Default scrapers with domains
const DEFAULT_SCRAPERS = [
  {
    name: "Bato.to",
    mangaModule: "bato",
    chapterModule: "bato",
    type: "both",
    description: "Scraper for Bato.to manga site",
    domains: ["bato.to"]
  },
  {
    name: "DoujinDesu",
    mangaModule: "doujindesu",
    chapterModule: "doujindesu",
    type: "both",
    description: "Scraper for DoujinDesu manga site",
    domains: ["doujindesu.tv"]
  },
  {
    name: "Ikiru",
    mangaModule: "ikiru",
    chapterModule: "ikiru",
    type: "both",
    description: "Scraper for Ikiru manga site",
    domains: ["id.ikiru.wtf"]
  },
  {
    name: "Kiryuu",
    mangaModule: "kiryuu",
    chapterModule: "kiryuu",
    type: "both",
    description: "Scraper for Kiryuu manga site",
    domains: ["kiryuu01.com"]
  },
  {
    name: "KomikAV",
    mangaModule: "komikav",
    chapterModule: "komikav",
    type: "both",
    description: "Scraper for KomikAV manga site",
    domains: ["apkomik.cc"]
  },
  {
    name: "KomikCast",
    mangaModule: "komikcast",
    chapterModule: "komikcast",
    type: "both",
    description: "Scraper for KomikCast manga site",
    domains: ["komikcast02.com"]
  },
  {
    name: "PojokManga",
    mangaModule: "pojokmanga",
    chapterModule: "pojokmanga",
    type: "both",
    description: "Scraper for PojokManga manga site",
    domains: ["pojokmanga.info"]
  },
  {
    name: "Shinigami",
    mangaModule: "shinigami",
    chapterModule: "shinigami",
    type: "both",
    description: "Scraper for Shinigami manga site",
    domains: ["id.shinigami.asia"]
  },
  {
    name: "SoulScans",
    mangaModule: "soulscans",
    chapterModule: "soulscans",
    type: "both",
    description: "Scraper for SoulScans manga site",
    domains: ["soulscans.my.id"]
  },
  {
    name: "TukangKomik",
    mangaModule: "tukangkomik",
    chapterModule: "tukangkomik",
    type: "both",
    description: "Scraper for TukangKomik manga site",
    domains: ["tukangkomik.co"]
  },
  {
    name: "WestManga",
    mangaModule: "westmanga",
    chapterModule: "westmanga",
    type: "both",
    description: "Scraper for WestManga manga site",
    domains: ["westmanga.me"]
  }
];

/**
 * Create admin user
 */
async function createAdminUser() {
  try {
    // Check if admin user exists
    const adminExists = await User.findOne({ where: { role: 'admin' } });
    
    if (!adminExists) {
      // Create default admin user
      await User.create({
        username: 'admin',
        email: 'admin@example.com',
        hashedPassword: await bcrypt.hash('adminpassword', 10),
        role: 'admin'
      });
      
      logger.info('Default admin user created successfully.');
    } else {
      logger.info('Admin user already exists, skipping creation.');
    }
  } catch (error) {
    logger.error(`Error creating admin user: ${error.message}`);
    throw error;
  }
}

/**
 * Create default genres
 */
async function createDefaultGenres() {
  try {
    for (const genreName of DEFAULT_GENRES) {
      // Check if genre exists
      const genreExists = await Genre.findOne({ where: { name: genreName } });
      
      if (!genreExists) {
        await Genre.create({ name: genreName });
        logger.info(`Created genre: ${genreName}`);
      }
    }
    
    logger.info('Default genres created successfully');
  } catch (error) {
    logger.error(`Error creating default genres: ${error.message}`);
    throw error;
  }
}

/**
 * Initialize database
 */
async function initDB() {
  try {
    // Create all tables
    await sequelize.sync();
    logger.info('Database tables created successfully.');
    
    // Create admin user
    await createAdminUser();
    
    // Create default genres
    await createDefaultGenres();
    
    // Create default scrapers
    await createDefaultScrapers();
    
    logger.info('Database initialization completed successfully.');
  } catch (error) {
    logger.error(`Error initializing database: ${error.message}`);
    throw error;
  }
}

/**
 * Create default scrapers
 */
async function createDefaultScrapers() {
  try {
    for (const scraperData of DEFAULT_SCRAPERS) {
      // Check if scraper already exists
      const existingScraper = await Scraper.findOne({ 
        where: { mangaModule: scraperData.mangaModule } 
      });
      
      if (!existingScraper) {
        // Create new scraper
        const scraper = await Scraper.create({
          name: scraperData.name,
          mangaModule: scraperData.mangaModule,
          chapterModule: scraperData.chapterModule,
          type: scraperData.type,
          description: scraperData.description,
          status: 'active'
        });
        
        // Add domains
        for (let i = 0; i < scraperData.domains.length; i++) {
          await ScraperDomain.create({
            domain: scraperData.domains[i],
            isPrimary: i === 0,  // First domain is primary
            isActive: true,
            scraperId: scraper.id
          });
        }
        
        logger.info(`Created scraper: ${scraperData.name}`);
      } else {
        // Update existing scraper
        await existingScraper.update({
          name: scraperData.name,
          chapterModule: scraperData.chapterModule,
          type: scraperData.type,
          description: scraperData.description
        });
        
        // Check for new domains
        const existingDomains = await ScraperDomain.findAll({
          where: { scraperId: existingScraper.id }
        });
        
        const existingDomainNames = existingDomains.map(d => d.domain);
        
        for (let i = 0; i < scraperData.domains.length; i++) {
          const domain = scraperData.domains[i];
          
          if (!existingDomainNames.includes(domain)) {
            // Add new domain
            await ScraperDomain.create({
              domain: domain,
              isPrimary: existingDomains.length === 0 ? true : false,
              isActive: true,
              scraperId: existingScraper.id
            });
            
            logger.info(`Added domain ${domain} to scraper ${scraperData.name}`);
          }
        }
      }
    }
    
    logger.info('Default scrapers created successfully');
  } catch (error) {
    logger.error(`Error creating default scrapers: ${error.message}`);
    throw error;
  }
}

// If this file is run directly, initialize the database
if (require.main === module) {
  initDB()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Failed to initialize database:', err);
      process.exit(1);
    });
}

// Export functions for use in other modules
module.exports = {
  initDB,
  createAdminUser,
  createDefaultGenres,
  createDefaultScrapers
};