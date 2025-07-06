FROM node:lts-alpine

RUN apk update && apk upgrade
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY ./src ./src
COPY ./shaka-packager-bin ./shaka-packager-bin
COPY ./package.json ./
COPY ./tsconfig.json ./
COPY ./start.sh ./

RUN npm install
RUN npm run build
RUN npm prune --production
RUN rm -rf ./src

ENV NODE_ENV=production

EXPOSE 3000

RUN chmod +x ./start.sh

CMD ["./start.sh"] 