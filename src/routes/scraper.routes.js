const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { authenticateJWT, isAdmin } = require('../middleware/auth');
const { Scraper, ScraperDomain } = require('../db/models');
const { ScraperAdapter } = require('../services/scraperAdapter');
const logger = require('../utils/logger');
const { Op } = require('sequelize');

const router = express.Router();

/**
 * @route   GET /api/scraper
 * @desc    Get all scrapers
 * @access  Private/Admin
 */
router.get('/', [
  authenticateJWT, 
  isAdmin,
  query('status').optional().isIn(['active', 'inactive', 'deprecated']).withMessage('Status tidak valid')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    const { status } = req.query;
    
    // Build query
    const query = {};
    if (status) {
      query.status = status;
    }
    
    // Get scrapers with active domains
    const scrapers = await Scraper.findAll({
      where: query,
      include: [{
        model: ScraperDomain,
        as: 'domains',
        where: { isActive: true },
        required: false
      }]
    });
    
    // Format response
    const result = scrapers.map(scraper => {
      // Get active domains
      const domains = scraper.domains
        .filter(domain => domain.isActive)
        .map(domain => domain.domain);
        
      return {
        id: scraper.id,
        name: scraper.name,
        module_name: scraper.mangaModule,
        type: scraper.type,
        description: scraper.description || '',
        status: scraper.status,
        domains,
        created_at: scraper.createdAt,
        updated_at: scraper.updatedAt
      };
    });
    
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/scraper/:id
 * @desc    Get scraper details
 * @access  Private/Admin
 */
router.get('/:id', [
  authenticateJWT,
  isAdmin,
  param('id').isInt().withMessage('ID harus berupa angka')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    // Get scraper with domains
    const scraper = await Scraper.findByPk(req.params.id, {
      include: [{
        model: ScraperDomain,
        as: 'domains'
      }]
    });
    
    if (!scraper) {
      return res.status(404).json({
        status: 'error',
        message: 'Scraper tidak ditemukan'
      });
    }
    
    // Format domain details
    const domainDetails = scraper.domains.map(domain => ({
      id: domain.id,
      domain: domain.domain,
      is_primary: domain.isPrimary,
      is_active: domain.isActive,
      scraper_id: domain.scraperId,
      created_at: domain.createdAt,
      updated_at: domain.updatedAt
    }));
    
    // Get active domains
    const domains = scraper.domains
      .filter(domain => domain.isActive)
      .map(domain => domain.domain);
    
    return res.json({
      id: scraper.id,
      name: scraper.name,
      module_name: scraper.mangaModule,
      type: scraper.type,
      description: scraper.description || '',
      status: scraper.status,
      domains,
      domain_details: domainDetails,
      created_at: scraper.createdAt,
      updated_at: scraper.updatedAt
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/scraper
 * @desc    Create new scraper
 * @access  Private/Admin
 */
router.post('/', [
  authenticateJWT,
  isAdmin,
  body('name').notEmpty().withMessage('Name tidak boleh kosong'),
  body('module_name').notEmpty().withMessage('Module name tidak boleh kosong'),
  body('type').isIn(['manga', 'chapter', 'both']).withMessage('Type tidak valid'),
  body('domains').isArray({ min: 1 }).withMessage('Domains harus berupa array dengan minimal 1 item')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    const { name, module_name, type, description, status, domains } = req.body;
    
    // Check if module_name already exists
    const existing = await Scraper.findOne({ where: { mangaModule: module_name } });
    if (existing) {
      return res.status(400).json({
        status: 'error',
        message: `Scraper with module name '${module_name}' already exists`
      });
    }
    
    // Create new scraper
    const newScraper = await Scraper.create({
      name,
      mangaModule: module_name,
      chapterModule: module_name,  // Default to same as manga module
      type,
      description,
      status: status || 'active'
    });
    
    // Add domains
    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i];
      
      // Check if domain already assigned to another scraper
      const existingDomain = await ScraperDomain.findOne({ where: { domain } });
      if (existingDomain) {
        await newScraper.destroy();  // Roll back scraper creation
        return res.status(400).json({
          status: 'error',
          message: `Domain '${domain}' is already assigned to another scraper`
        });
      }
      
      await ScraperDomain.create({
        domain,
        isPrimary: i === 0,  // First domain is primary
        isActive: true,
        scraperId: newScraper.id
      });
    }
    
    // Refresh scrapers in adapter
    const adapter = new ScraperAdapter();
    await adapter.refreshScrapers();
    
    return res.status(201).json({
      id: newScraper.id,
      name: newScraper.name,
      module_name: newScraper.mangaModule,
      type: newScraper.type,
      description: newScraper.description || '',
      status: newScraper.status,
      domains,
      created_at: newScraper.createdAt,
      updated_at: newScraper.updatedAt
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/scraper/:id
 * @desc    Update scraper
 * @access  Private/Admin
 */
router.put('/:id', [
  authenticateJWT,
  isAdmin,
  param('id').isInt().withMessage('ID harus berupa angka'),
  body('name').optional().notEmpty().withMessage('Name tidak boleh kosong'),
  body('module_name').optional().notEmpty().withMessage('Module name tidak boleh kosong'),
  body('type').optional().isIn(['manga', 'chapter', 'both']).withMessage('Type tidak valid'),
  body('domains').optional().isArray().withMessage('Domains harus berupa array')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    const { name, module_name, type, description, status, domains } = req.body;
    
    // Get scraper
    const scraper = await Scraper.findByPk(req.params.id);
    if (!scraper) {
      return res.status(404).json({
        status: 'error',
        message: 'Scraper tidak ditemukan'
      });
    }
    
    // Update scraper fields if provided
    if (name) scraper.name = name;
    
    if (module_name && module_name !== scraper.mangaModule) {
      // Check if new module_name already exists
      const existing = await Scraper.findOne({ 
        where: { mangaModule: module_name },
        attributes: ['id']
      });
      
      if (existing && existing.id !== scraper.id) {
        return res.status(400).json({
          status: 'error',
          message: `Scraper with module name '${module_name}' already exists`
        });
      }
      
      scraper.mangaModule = module_name;
      // Also update chapter module if it was the same as manga module
      if (scraper.chapterModule === scraper.mangaModule) {
        scraper.chapterModule = module_name;
      }
    }
    
    if (type) scraper.type = type;
    if (description !== undefined) scraper.description = description;
    if (status) scraper.status = status;
    
    await scraper.save();
    
    // Update domains if provided
    if (domains && Array.isArray(domains)) {
      // Get current domains
      const currentDomains = await ScraperDomain.findAll({
        where: { scraperId: scraper.id }
      });
      
      const currentDomainMap = {};
      currentDomains.forEach(domain => {
        currentDomainMap[domain.domain] = domain;
      });
      
      // Process each domain in the new list
      for (let i = 0; i < domains.length; i++) {
        const domainStr = domains[i];
        
        if (currentDomainMap[domainStr]) {
          // Update existing domain
          await currentDomainMap[domainStr].update({
            isPrimary: i === 0,  // First domain is primary
            isActive: true
          });
          
          // Remove from map to track which domains are processed
          delete currentDomainMap[domainStr];
        } else {
          // Check if domain already assigned to another scraper
          const existingDomain = await ScraperDomain.findOne({ 
            where: { domain: domainStr },
            attributes: ['id', 'scraperId']
          });
          
          if (existingDomain && existingDomain.scraperId !== scraper.id) {
            return res.status(400).json({
              status: 'error',
              message: `Domain '${domainStr}' is already assigned to another scraper`
            });
          }
          
          // Create new domain
          await ScraperDomain.create({
            domain: domainStr,
            isPrimary: i === 0,  // First domain is primary
            isActive: true,
            scraperId: scraper.id
          });
        }
      }
      
      // Domains not in new list should be set to inactive (not deleted)
      for (const domainStr in currentDomainMap) {
        await currentDomainMap[domainStr].update({
          isActive: false,
          isPrimary: false
        });
      }
    }
    
    // Refresh scrapers in adapter
    const adapter = new ScraperAdapter();
    await adapter.refreshScrapers();
    
    // Get updated domain list
    const updatedDomains = await ScraperDomain.findAll({
      where: { scraperId: scraper.id, isActive: true },
      attributes: ['domain']
    });
    
    const activeDomains = updatedDomains.map(domain => domain.domain);
    
    return res.json({
      id: scraper.id,
      name: scraper.name,
      module_name: scraper.mangaModule,
      type: scraper.type,
      description: scraper.description || '',
      status: scraper.status,
      domains: activeDomains,
      created_at: scraper.createdAt,
      updated_at: scraper.updatedAt
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/scraper/:id
 * @desc    Delete scraper
 * @access  Private/Admin
 */
router.delete('/:id', [
  authenticateJWT,
  isAdmin,
  param('id').isInt().withMessage('ID harus berupa angka')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    // Get scraper
    const scraper = await Scraper.findByPk(req.params.id);
    if (!scraper) {
      return res.status(404).json({
        status: 'error',
        message: 'Scraper tidak ditemukan'
      });
    }
    
    // Store name for response
    const scraperName = scraper.name;
    
    // Delete scraper (will also delete associated domains due to cascade)
    await scraper.destroy();
    
    // Refresh scrapers in adapter
    const adapter = new ScraperAdapter();
    await adapter.refreshScrapers();
    
    return res.json({
      status: 'success',
      message: `Scraper '${scraperName}' berhasil dihapus`
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/scraper/:id/domains
 * @desc    Add domain to scraper
 * @access  Private/Admin
 */
router.post('/:id/domains', [
  authenticateJWT,
  isAdmin,
  param('id').isInt().withMessage('ID harus berupa angka'),
  body('domain').notEmpty().withMessage('Domain tidak boleh kosong'),
  body('is_primary').optional().isBoolean().withMessage('is_primary harus boolean'),
  body('is_active').optional().isBoolean().withMessage('is_active harus boolean')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    const { domain, is_primary = false, is_active = true } = req.body;
    
    // Get scraper
    const scraper = await Scraper.findByPk(req.params.id);
    if (!scraper) {
      return res.status(404).json({
        status: 'error',
        message: 'Scraper tidak ditemukan'
      });
    }
    
    // Check if domain already exists
    const existingDomain = await ScraperDomain.findOne({ where: { domain } });
    if (existingDomain) {
      return res.status(400).json({
        status: 'error',
        message: `Domain '${domain}' is already assigned to a scraper`
      });
    }
    
    // If setting as primary, update all other domains to non-primary
    if (is_primary) {
      await ScraperDomain.update(
        { isPrimary: false },
        { where: { scraperId: scraper.id } }
      );
    }
    
    // Create new domain
    const newDomain = await ScraperDomain.create({
      domain,
      isPrimary: is_primary,
      isActive: is_active,
      scraperId: scraper.id
    });
    
    // Refresh scrapers in adapter
    const adapter = new ScraperAdapter();
    await adapter.refreshScrapers();
    
    return res.status(201).json({
      id: newDomain.id,
      domain: newDomain.domain,
      is_primary: newDomain.isPrimary,
      is_active: newDomain.isActive,
      scraper_id: newDomain.scraperId,
      created_at: newDomain.createdAt,
      updated_at: newDomain.updatedAt
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/scraper/:id/domains/:domainId
 * @desc    Update domain
 * @access  Private/Admin
 */
router.put('/:id/domains/:domainId', [
  authenticateJWT,
  isAdmin,
  param('id').isInt().withMessage('Scraper ID harus berupa angka'),
  param('domainId').isInt().withMessage('Domain ID harus berupa angka'),
  body('domain').optional().notEmpty().withMessage('Domain tidak boleh kosong'),
  body('is_primary').optional().isBoolean().withMessage('is_primary harus boolean'),
  body('is_active').optional().isBoolean().withMessage('is_active harus boolean')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    const { domain, is_primary, is_active } = req.body;
    
    // Get domain
    const scraperDomain = await ScraperDomain.findOne({
      where: {
        id: req.params.domainId,
        scraperId: req.params.id
      }
    });
    
    if (!scraperDomain) {
      return res.status(404).json({
        status: 'error',
        message: 'Domain tidak ditemukan'
      });
    }
    
    // Check if new domain already exists
    if (domain && domain !== scraperDomain.domain) {
      const existingDomain = await ScraperDomain.findOne({
        where: { domain, id: { [Op.ne]: scraperDomain.id } }
      });
      
      if (existingDomain) {
        return res.status(400).json({
          status: 'error',
          message: `Domain '${domain}' is already assigned to a scraper`
        });
      }
    }
    
    // If setting as primary, update all other domains to non-primary
    if (is_primary && !scraperDomain.isPrimary) {
      await ScraperDomain.update(
        { isPrimary: false },
        { 
          where: { 
            scraperId: req.params.id,
            id: { [Op.ne]: scraperDomain.id }
          }
        }
      );
    }
    
    // Update domain
    if (domain) scraperDomain.domain = domain;
    if (is_primary !== undefined) scraperDomain.isPrimary = is_primary;
    if (is_active !== undefined) scraperDomain.isActive = is_active;
    
    await scraperDomain.save();
    
    // Refresh scrapers in adapter
    const adapter = new ScraperAdapter();
    await adapter.refreshScrapers();
    
    return res.json({
      id: scraperDomain.id,
      domain: scraperDomain.domain,
      is_primary: scraperDomain.isPrimary,
      is_active: scraperDomain.isActive,
      scraper_id: scraperDomain.scraperId,
      created_at: scraperDomain.createdAt,
      updated_at: scraperDomain.updatedAt
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/scraper/:id/domains/:domainId
 * @desc    Delete domain
 * @access  Private/Admin
 */
router.delete('/:id/domains/:domainId', [
  authenticateJWT,
  isAdmin,
  param('id').isInt().withMessage('Scraper ID harus berupa angka'),
  param('domainId').isInt().withMessage('Domain ID harus berupa angka')
], async (req, res, next) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: errors.array().map(err => err.msg)
      });
    }
    
    // Get domain
    const domain = await ScraperDomain.findOne({
      where: {
        id: req.params.domainId,
        scraperId: req.params.id
      }
    });
    
    if (!domain) {
      return res.status(404).json({
        status: 'error',
        message: 'Domain tidak ditemukan'
      });
    }
    
    // Check if this is the only domain for the scraper
    const domainCount = await ScraperDomain.count({
      where: { scraperId: req.params.id }
    });
    
    if (domainCount === 1) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot delete the only domain for a scraper. Delete the scraper instead.'
      });
    }
    
    // If this is the primary domain, set another domain as primary
    if (domain.isPrimary) {
      const otherDomain = await ScraperDomain.findOne({
        where: {
          scraperId: req.params.id,
          id: { [Op.ne]: domain.id }
        }
      });
      
      if (otherDomain) {
        otherDomain.isPrimary = true;
        await otherDomain.save();
      }
    }
    
    // Store domain name for response
    const domainName = domain.domain;
    
    // Delete domain
    await domain.destroy();
    
    // Refresh scrapers in adapter
    const adapter = new ScraperAdapter();
    await adapter.refreshScrapers();
    
    return res.json({
      status: 'success',
      message: `Domain '${domainName}' berhasil dihapus`
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/scraper/refresh
 * @desc    Refresh scraper list
 * @access  Private/Admin
 */
router.post('/refresh', [authenticateJWT, isAdmin], async (req, res, next) => {
  try {
    // Refresh scrapers in adapter
    const adapter = new ScraperAdapter();
    await adapter.refreshScrapers();
    
    return res.json({
      status: 'success',
      message: 'Scrapers berhasil di-refresh'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;