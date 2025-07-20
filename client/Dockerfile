# Stage 1: The Builder
# This stage builds the app
FROM node:18 AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Pass the public URL as a build argument
ARG NEXT_PUBLIC_SIGNALING_SERVER_URL
ENV NEXT_PUBLIC_SIGNALING_SERVER_URL=$NEXT_PUBLIC_SIGNALING_SERVER_URL

# Build the Next.js app
RUN npm run build

# ---
# Stage 2: The Runner
# This stage runs the built app
FROM node:18-alpine

WORKDIR /app

# Copy the standalone output from the builder stage
COPY --from=builder /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Expose the port the app runs on
EXPOSE 3000

# Set the command to run the production server
CMD ["node", "server.js"]