FROM node:lts-alpine

WORKDIR /app

COPY ./src ./src
COPY ./package.json ./
COPY ./pnpm-lock.yaml ./
COPY ./tsconfig.json ./

RUN npm install -g pnpm

RUN pnpm install
RUN pnpm build

RUN pnpm prune --prod
RUN rm -rf ./src

ENV NODE_ENV=production

EXPOSE 3000

CMD ["pnpm", "run", "start"]