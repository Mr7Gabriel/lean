FROM node:16-slim

# Install Chrome for Selenium
RUN apt-get update && apt-get install -y wget gnupg2 ca-certificates \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p data logs downloads

# Initialize the database
RUN node src/db/init-db.js

# Expose the port
EXPOSE 8000

# Run the application
CMD ["node", "src/server.js"]