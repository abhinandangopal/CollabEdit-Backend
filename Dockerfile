# Use Node.js Linux image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first (for caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose the API Port
EXPOSE 8081

# Start the server using the script we set up
CMD ["npm", "run", "dev"]