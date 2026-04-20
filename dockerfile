FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY proxy.js .
# PORT is set via environment variable in docker-compose.yml
EXPOSE ${PORT:-3085}
CMD ["node", "proxy.js"]