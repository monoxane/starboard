FROM node:16.6.0-alpine

WORKDIR /app
ADD . /app

RUN yarn
ENTRYPOINT yarn run start

