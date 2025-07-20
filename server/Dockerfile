# Use an official Node.js runtime as a parent image
FROM node:18

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install

# Copy app source code
COPY . .

# Build the TypeScript code
RUN npm run build

# Your app binds to port 4000
EXPOSE 4000

# Command to run the app
CMD [ "npm", "start" ]