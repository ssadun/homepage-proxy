FROM node:20-alpine@sha256:6c3d37db51021b2b0c0c8e0e0d0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY proxy.js .
# PORT is set via environment variable in docker-compose.yml
EXPOSE ${PORT:-3085}
CMD ["node", "proxy.js"]