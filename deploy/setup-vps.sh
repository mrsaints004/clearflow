#!/bin/bash
# ClearFlow VPS Setup Script
# Tested on Ubuntu 22.04+ / Debian 12+
# Run as root or with sudo

set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/opt/clearflow"

if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo ./setup-vps.sh your-domain.com"
  exit 1
fi

echo "=== ClearFlow VPS Setup ==="
echo "Domain: $DOMAIN"
echo "Install directory: $APP_DIR"
echo ""

# 1. System dependencies
echo "[1/8] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git nginx certbot python3-certbot-nginx ufw

# 2. Install Node.js 20
echo "[2/8] Installing Node.js 20..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "Node.js $(node -v) installed"

# 3. Create clearflow user
echo "[3/8] Creating clearflow system user..."
if ! id clearflow &>/dev/null; then
  useradd --system --shell /bin/false --home-dir $APP_DIR clearflow
fi

# 4. Create app directory
echo "[4/8] Setting up application directory..."
mkdir -p $APP_DIR/backend/data
chown -R clearflow:clearflow $APP_DIR

# 5. Firewall
echo "[5/8] Configuring firewall..."
ufw --force enable
ufw allow ssh
ufw allow 'Nginx Full'
ufw deny 3002  # Block direct API access — force through nginx

# 6. Nginx config
echo "[6/8] Configuring Nginx..."
NGINX_CONF="/etc/nginx/sites-available/clearflow"
cat > "$NGINX_CONF" << 'NGINX_EOF'
server {
    listen 80;
    server_name DOMAIN_PLACEHOLDER;

    location /api/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
    }

    location / {
        root /opt/clearflow/frontend/build;
        try_files $uri $uri/ /index.html;

        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 30d;
            add_header Cache-Control "public, immutable";
        }
    }

    location ~ /\. {
        deny all;
    }

    client_max_body_size 10m;
}
NGINX_EOF

sed -i "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" "$NGINX_CONF"
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/clearflow
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# 7. SSL with Let's Encrypt
echo "[7/8] Setting up SSL certificate..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" --redirect || {
  echo "WARNING: Certbot failed. You can run it manually later:"
  echo "  certbot --nginx -d $DOMAIN"
}

# 8. Systemd service
echo "[8/8] Installing systemd service..."
cp "$APP_DIR/deploy/clearflow.service" /etc/systemd/system/clearflow.service 2>/dev/null || {
  cat > /etc/systemd/system/clearflow.service << 'SERVICE_EOF'
[Unit]
Description=ClearFlow API Server
After=network.target

[Service]
Type=simple
User=clearflow
Group=clearflow
WorkingDirectory=/opt/clearflow/backend
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=clearflow
Environment=NODE_ENV=production
Environment=PORT=3002
EnvironmentFile=/opt/clearflow/.env.production
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/clearflow/backend/data
PrivateTmp=true
LimitNOFILE=65536
MemoryMax=512M

[Install]
WantedBy=multi-user.target
SERVICE_EOF
}
systemctl daemon-reload
systemctl enable clearflow

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy your code to $APP_DIR:"
echo "     rsync -avz --exclude node_modules --exclude .git . root@your-vps:$APP_DIR/"
echo ""
echo "  2. Create production env file:"
echo "     cp $APP_DIR/deploy/.env.production.example $APP_DIR/.env.production"
echo "     nano $APP_DIR/.env.production  # Fill in real secrets"
echo ""
echo "  3. Build the application:"
echo "     cd $APP_DIR && ./deploy/deploy.sh"
echo ""
echo "  4. Start the service:"
echo "     systemctl start clearflow"
echo "     journalctl -u clearflow -f  # Watch logs"
echo ""
echo "  5. Verify:"
echo "     curl https://$DOMAIN/api/health"
