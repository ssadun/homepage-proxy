FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY resolv.conf /etc/resolv.conf
RUN npm install --omit=dev
COPY proxy.js .
# PORT is set via environment variable in docker-compose.yml
EXPOSE ${PORT:-3085}
CMD ["node", "proxy.js"]