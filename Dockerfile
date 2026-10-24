FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
# El inventario NO se copia a la imagen: data/ está en .dockerignore para que un
# inventory.json real (con IPs y contraseñas) nunca quede empaquetado. docker-compose
# monta el volumen fids-data en /app/data y ahí se importa/configura el inventario.
RUN mkdir -p /app/data && chown node:node /app/data

# Dentro del contenedor escucha en todas las interfaces; docker-compose solo lo publica en 127.0.0.1
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080

USER node
# --openssl-legacy-provider: la autenticación VNC usa DES
CMD ["node", "--openssl-legacy-provider", "server.js"]
