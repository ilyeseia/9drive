# syntax=docker/dockerfile:1
FROM node:20-alpine AS build

WORKDIR /app

# Vite embeds these at build time — rebuild when they change.
ARG VITE_API_URL=
ARG VITE_RECAPTCHA_SITE_KEY=
ARG VITE_ALLOWED_REDIRECT_HOSTS=accounts.google.com
ARG VITE_ENABLE_OFFICE_PREVIEW=false
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_RECAPTCHA_SITE_KEY=$VITE_RECAPTCHA_SITE_KEY
ENV VITE_ALLOWED_REDIRECT_HOSTS=$VITE_ALLOWED_REDIRECT_HOSTS
ENV VITE_ENABLE_OFFICE_PREVIEW=$VITE_ENABLE_OFFICE_PREVIEW

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Unprivileged nginx: runs entirely as uid 101, listens on 8080, so the
# container works with `cap_drop: [ALL]` and `no-new-privileges`.
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
