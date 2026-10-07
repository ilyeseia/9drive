#!/bin/sh
set -e

if ! id "$FTP_USER" >/dev/null 2>&1; then
  useradd -m -s /usr/sbin/nologin "$FTP_USER"
fi
echo "$FTP_USER:$FTP_PASS" | chpasswd
mkdir -p "/home/$FTP_USER/inbox" "/home/$FTP_USER/archive" "/home/$FTP_USER/failed"
mkdir -p /var/run/vsftpd/empty
grep -qx "/usr/sbin/nologin" /etc/shells 2>/dev/null || echo "/usr/sbin/nologin" >> /etc/shells
chown -R "$FTP_USER:$FTP_USER" "/home/$FTP_USER"
sed -i "s|__PASV_ADDRESS__|${PASV_ADDRESS}|g" /etc/vsftpd.conf

exec /usr/sbin/vsftpd /etc/vsftpd.conf
