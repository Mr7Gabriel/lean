const { Sequelize, DataTypes } = require('sequelize');
const config = require('../config');
const logger = require('../utils/logger');
const path = require('path');

// Create Sequelize instance with SQLite
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: config.database.path,
  logging: msg => logger.debug(msg)
});

// Define User model
const User = sequelize.define('User', {
  username: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  hashedPassword: {
    type: DataTypes.STRING,
    allowNull: false
  },
  role: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'author',
    validate: {
      isIn: [['admin', 'author']]
    }
  },
  apiUsername: {
    type: DataTypes.STRING,
    allowNull: true
  },
  apiPassword: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  timestamps: true,
  underscored: true,
  tableName: 'users'
});

// Define Manga model
const Manga = sequelize.define('Manga', {
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  titleAlt: {
    type: DataTypes.STRING,
    allowNull: true
  },
  author: {
    type: DataTypes.STRING,
    allowNull: false
  },
  artist: {
    type: DataTypes.STRING,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      isIn: [['Ongoing', 'Completed', 'Hiatus']]
    }
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  thumbnailUrl: {
    type: DataTypes.STRING,
    allowNull: true
  },
  wpId: {
    type: DataTypes.INTEGER,
    unique: true
  },
  wpUrl: {
    type: DataTypes.STRING
  },
  hot: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  project: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  score: {
    type: DataTypes.FLOAT,
    validate: {
      min: 0,
      max: 10
    }
  },
  type: {
    type: DataTypes.STRING,
    validate: {
      isIn: [['Manga', 'Manhua', 'Manhwa', 'Comic', 'Novel']]
    }
  },
  serialization: {
    type: DataTypes.STRING,
    allowNull: true
  },
  published: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  timestamps: true,
  underscored: true,
  tableName: 'mangas'
});

// Define Chapter model
const Chapter = sequelize.define('Chapter', {
  chapterNumber: {
    type: DataTypes.STRING,
    allowNull: false
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  wpId: {
    type: DataTypes.INTEGER,
    unique: true
  },
  wpUrl: {
    type: DataTypes.STRING
  }
}, {
  timestamps: true,
  underscored: true,
  tableName: 'chapters'
});

// Define Chapter Image model
const ChapterImage = sequelize.define('ChapterImage', {
  url: {
    type: DataTypes.STRING,
    allowNull: false
  },
  order: {
    type: DataTypes.INTEGER,
    allowNull: false
  }
}, {
  timestamps: true,
  underscored: true,
  tableName: 'chapter_images'
});

// Define Genre model
const Genre = sequelize.define('Genre', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  }
}, {
  timestamps: true,
  underscored: true,
  tableName: 'genres'
});

// Define Scraper model
const Scraper = sequelize.define('Scraper', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  mangaModule: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  chapterModule: {
    type: DataTypes.STRING,
    allowNull: true
  },
  type: {
    type: DataTypes.STRING,
    defaultValue: 'both',
    validate: {
      isIn: [['manga', 'chapter', 'both']]
    }
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'active',
    validate: {
      isIn: [['active', 'inactive', 'deprecated']]
    }
  }
}, {
  timestamps: true,
  underscored: true,
  tableName: 'scrapers'
});

// Define ScraperDomain model
const ScraperDomain = sequelize.define('ScraperDomain', {
  domain: {
    type: DataTypes.STRING,
    allowNull: false
  },
  isPrimary: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  timestamps: true,
  underscored: true,
  tableName: 'scraper_domains',
  indexes: [
    {
      unique: true,
      fields: ['domain', 'scraper_id']
    }
  ]
});

// Define relationships
User.hasMany(Manga, { as: 'mangas', foreignKey: 'userId' });
Manga.belongsTo(User, { foreignKey: 'userId' });

Manga.hasMany(Chapter, { as: 'chapters', foreignKey: 'mangaId', onDelete: 'CASCADE' });
Chapter.belongsTo(Manga, { foreignKey: 'mangaId' });

Chapter.hasMany(ChapterImage, { as: 'images', foreignKey: 'chapterId', onDelete: 'CASCADE' });
ChapterImage.belongsTo(Chapter, { foreignKey: 'chapterId' });

// Many-to-Many: Manga <-> Genre through manga_genre
Manga.belongsToMany(Genre, { through: 'manga_genre', foreignKey: 'mangaId' });
Genre.belongsToMany(Manga, { through: 'manga_genre', foreignKey: 'genreId' });

// One-to-Many: Scraper -> ScraperDomain
Scraper.hasMany(ScraperDomain, { as: 'domains', foreignKey: 'scraperId', onDelete: 'CASCADE' });
ScraperDomain.belongsTo(Scraper, { foreignKey: 'scraperId' });

// Export models and Sequelize instance
module.exports = {
  sequelize,
  User,
  Manga,
  Chapter,
  ChapterImage,
  Genre,
  Scraper,
  ScraperDomain
};