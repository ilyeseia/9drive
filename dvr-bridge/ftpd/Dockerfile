FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends vsftpd curl \
    && rm -rf /var/lib/apt/lists/*

COPY vsftpd.conf /etc/vsftpd.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 21 2120-2130

ENTRYPOINT ["/entrypoint.sh"]
