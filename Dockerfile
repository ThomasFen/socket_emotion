FROM bitnami/node:13

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

RUN useradd -r -u 1001 -g root nonroot
RUN chown -R nonroot /app
USER nonroot

ENV PORT="8010"

CMD [ "node", "server.js" ]