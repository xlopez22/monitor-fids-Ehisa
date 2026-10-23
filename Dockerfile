FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
# Inventario inicial. docker-compose monta un volumen en /app/data: la primera vez Docker lo
# llena con este contenido y después conserva los equipos agregados y contraseñas propias.
COPY --chown=node:node data ./data

# Dentro del contenedor escucha en todas las interfaces; docker-compose solo lo publica en 127.0.0.1
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080

USER node
# --openssl-legacy-provider: la autenticación VNC usa DES
CMD ["node", "--openssl-legacy-provider", "server.js"]
