FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/math-sprout.sqlite
ENV HOSTNAME=0.0.0.0
ENV PORT=43123

EXPOSE 43123
VOLUME ["/data"]

CMD ["npm", "start"]
