const axios = require('axios');
const path = require('path');
const FormData = require('form-data');
const config = require('../config');
const logger = require('../utils/logger');

class CDNService {
  constructor() {
    this.baseUrl = config.cdn.baseUrl;
    this.apiEndpoint = config.cdn.apiEndpoint;
    this.publicUrl = config.cdn.publicUrl;
  }

  /**
   * Ensure folder exists on CDN
   * @param {string} folderPath - Path to folder
   * @returns {Promise<boolean>} - True if successful
   */
  async ensureFolderExists(folderPath) {
    try {
      // Check if folder exists
      const checkUrl = `${this.baseUrl}${this.apiEndpoint}/check`;
      const checkResponse = await axios.post(checkUrl, { path: folderPath });
      
      if (checkResponse.status === 200 && checkResponse.data.exists) {
        logger.info(`Folder already exists: ${folderPath}`);
        return true;
      }
      
      // Create folder if it doesn't exist
      const createUrl = `${this.baseUrl}${this.apiEndpoint}/folder`;
      const createResponse = await axios.post(createUrl, { path: folderPath });
      
      if (createResponse.status === 201) {
        logger.info(`Created folder: ${folderPath}`);
        return true;
      }
      
      logger.warn(`Failed to create folder ${folderPath}: ${createResponse.status} - ${JSON.stringify(createResponse.data)}`);
      return false;
    } catch (error) {
      logger.error(`Error ensuring folder exists: ${error.message}`);
      return false;
    }
  }

  /**
   * Upload file to CDN
   * @param {Buffer} fileData - Binary file data
   * @param {string} filePath - Path where file should be stored
   * @param {string} contentType - MIME type of file
   * @returns {Promise<string>} - Public URL of uploaded file
   */
  async uploadFile(fileData, filePath, contentType = 'image/jpeg') {
    try {
      // Ensure parent directory exists
      const parentDir = path.dirname(filePath);
      if (parentDir) {
        await this.ensureFolderExists(parentDir);
      }
      
      const url = `${this.baseUrl}${this.apiEndpoint}`;
      
      // Prepare form data
      const formData = new FormData();
      formData.append('file', fileData, {
        filename: path.basename(filePath),
        contentType: contentType
      });
      
      formData.append('path', parentDir || '/');
      
      // Upload file
      const response = await axios.post(url, formData, {
        headers: {
          ...formData.getHeaders(),
          'User-Agent': 'MangaMirrorAPI/1.0',
          'Accept': 'application/json'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      
      if (response.status === 200 || response.status === 201) {
        let publicUrl;
        
        if (response.data.publicUrl) {
          publicUrl = `${this.publicUrl}/${response.data.publicUrl}`;
        } else if (response.data.public_url) {
          publicUrl = `${this.publicUrl}/${response.data.public_url}`;
        } else {
          throw new Error('No public URL found in response');
        }
        
        logger.info(`Uploaded file to CDN: ${publicUrl}`);
        return publicUrl;
      } else {
        throw new Error(`Failed to upload file: ${response.status} - ${JSON.stringify(response.data)}`);
      }
    } catch (error) {
      logger.error(`Error uploading file: ${error.message}`);
      throw error;
    }
  }

  /**
   * Delete file from CDN
   * @param {string} filePath - Path of file to delete
   * @returns {Promise<boolean>} - True if file was deleted
   */
  async deleteFile(filePath) {
    try {
      const url = `${this.baseUrl}${this.apiEndpoint}`;
      
      const response = await axios.delete(url, {
        data: { path: filePath }
      });
      
      const success = response.status === 200 || response.status === 204;
      
      if (success) {
        logger.info(`Deleted file from CDN: ${filePath}`);
      } else {
        logger.warn(`Failed to delete file ${filePath}: ${response.status} - ${JSON.stringify(response.data)}`);
      }
      
      return success;
    } catch (error) {
      logger.error(`Error deleting file: ${error.message}`);
      return false;
    }
  }

  /**
   * List files in folder
   * @param {string} folderPath - Path of folder to list
   * @returns {Promise<Array>} - List of file objects
   */
  async listFiles(folderPath) {
    try {
      const url = `${this.baseUrl}${this.apiEndpoint}/list`;
      
      const response = await axios.get(url, {
        params: { path: folderPath }
      });
      
      if (response.status === 200) {
        const files = response.data.files || [];
        logger.info(`Listed ${files.length} files in folder: ${folderPath}`);
        return files;
      } else {
        logger.warn(`Failed to list files in ${folderPath}: ${response.status} - ${JSON.stringify(response.data)}`);
        return [];
      }
    } catch (error) {
      logger.error(`Error listing files: ${error.message}`);
      return [];
    }
  }

  /**
   * Upload base64 encoded image
   * @param {string} base64Data - Base64 encoded image data
   * @param {string} filePath - Path where file should be stored
   * @returns {Promise<string>} - Public URL of uploaded file
   */
  async uploadBase64Image(base64Data, filePath) {
    try {
      // Extract actual base64 data if it's a data URL
      let contentType = 'image/jpeg';  // Default
      let imageData = base64Data;
      
      if (base64Data.startsWith('data:image/')) {
        // Extract MIME type and data
        const matches = base64Data.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (matches) {
          contentType = `image/${matches[1]}`;
          imageData = matches[2];
        }
      }
      
      // Decode base64 to Buffer
      const fileData = Buffer.from(imageData, 'base64');
      
      // Upload to CDN
      return await this.uploadFile(fileData, filePath, contentType);
    } catch (error) {
      logger.error(`Error uploading base64 image: ${error.message}`);
      throw error;
    }
  }
}

// Export as singleton
module.exports = new CDNService();