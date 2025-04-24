const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

class WordPressClient {
  /**
   * Initialize WordPress API client with authentication credentials
   * @param {string} username - API username
   * @param {string} password - API password
   */
  constructor(username, password) {
    this.baseUrl = config.wordpress.baseUrl;
    this.apiEndpoint = config.wordpress.apiEndpoint;
    this.auth = { username, password };
  }

  /**
   * Make HTTP request to WordPress API
   * @param {string} method - HTTP method (GET, POST, etc)
   * @param {object} params - URL parameters
   * @param {object} data - Request body data
   * @param {object} files - Files to upload
   * @returns {Promise<object>} - API response
   * @private
   */
  async _makeRequest(method, params = null, data = null, files = null) {
    try {
      const url = `${this.baseUrl}${this.apiEndpoint}`;
      
      const headers = {};
      if (data && !files) {
        headers['Content-Type'] = 'application/json';
      }
      
      const requestConfig = {
        method,
        url,
        params,
        data: data && !files ? JSON.stringify(data) : data,
        auth: this.auth,
        headers
      };
      
      const response = await axios(requestConfig);
      
      if (response.status === 200 || response.status === 201) {
        return response.data;
      } else {
        throw new Error(`WordPress API request failed: ${response.status} - ${JSON.stringify(response.data)}`);
      }
    } catch (error) {
      if (error.response) {
        logger.error(`WordPress API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        throw new Error(`WordPress API request failed: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      } else {
        logger.error(`WordPress API error: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Get user information
   * @returns {Promise<object>} - User information
   */
  async getUserInfo() {
    return await this._makeRequest('GET', { type: 'me' });
  }

  /**
   * Create manga post
   * @param {object} manga - Manga data
   * @returns {Promise<object>} - Created manga response
   */
  async createManga(manga) {
    const response = await this._makeRequest('POST', { type: 'post' }, manga);
    
    if (response.success) {
      return {
        id: response.data.id,
        title: response.data.title,
        url: response.data.url,
        id_author: response.data.id_author
      };
    } else {
      throw new Error(`Failed to create manga: ${response.message}`);
    }
  }

  /**
   * Upload media (cover) for manga
   * @param {number} idAuthor - Author ID
   * @param {number} idPost - Post ID
   * @param {Buffer} imageData - Image binary data
   * @param {string} mimeType - Image MIME type
   * @returns {Promise<object>} - Upload response
   */
  async uploadMedia(idAuthor, idPost, imageData, mimeType) {
    // Base64 encode the image data
    const encodedImage = imageData.toString('base64');
    
    const data = {
      id_author: idAuthor,
      id_post: idPost,
      image: {
        mime: mimeType,
        data: encodedImage
      }
    };
    
    return await this._makeRequest('POST', { type: 'upload-media' }, data);
  }

  /**
   * Create manga chapter
   * @param {object} chapter - Chapter data
   * @returns {Promise<object>} - Created chapter response
   */
  async createChapter(chapter) {
    const response = await this._makeRequest('POST', { type: 'post-ch' }, chapter);
    
    if (response.success) {
      return {
        id: response.data.id,
        title: response.data.title,
        url: response.data.url,
        id_manga: chapter.id_manga
      };
    } else {
      throw new Error(`Failed to create chapter: ${response.message}`);
    }
  }

  /**
   * Get list of manga
   * @param {string} title - Optional title to filter by
   * @returns {Promise<Array>} - List of manga
   */
  async getMangaList(title = null) {
    const params = { type: 'show' };
    if (title) {
      params.show = title;
    }
    
    const response = await this._makeRequest('GET', params);
    
    if (response.success) {
      return response.data || [];
    } else {
      throw new Error(`Failed to get manga list: ${response.message}`);
    }
  }

  /**
   * Logout from WordPress API
   * @returns {Promise<object>} - Logout response
   */
  async logout() {
    return await this._makeRequest('POST', { type: 'logout' });
  }
}

module.exports = WordPressClient;