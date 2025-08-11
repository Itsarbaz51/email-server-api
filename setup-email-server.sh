#!/bin/bash
set -e

echo "🚀 Starting Secure Email Server Setup with MySQL..."

# Variables
DB_NAME="email_server_db"
DB_USER="email_user"
DB_PASS="email_pass"
MYSQL_ROOT_PASS="rootpassword"
API_DOMAIN="api.primewebdev.in"
DB_DOMAIN="db.primewebdev.in"  # Optional — we will secure this
ADMIN_EMAIL="admin@primewebdev.in"
API_PORT=5555
PROJECT_DIR="/var/www/email-server"
PHPMYADMIN_DIR="/usr/share/phpmyadmin"

# Update system
sudo apt update -y && sudo apt upgrade -y

# Remove old MySQL
echo "🗑 Removing old MySQL installation..."
sudo systemctl stop mysql || true
sudo apt purge -y mysql-server mysql-client mysql-common mysql-server-core-* mysql-client-core-* || true
sudo rm -rf /etc/mysql /var/lib/mysql
sudo apt autoremove -y
sudo apt autoclean -y

# Install dependencies
echo "📦 Installing required packages..."
sudo apt install -y nginx certbot python3-certbot-nginx mysql-server unzip curl ufw php-mbstring php-zip php-gd php-json php-curl php-cli php-fpm

# Configure MySQL root password and secure access
echo "🔐 Securing MySQL root user..."
sudo mysql --user=root <<MYSQL_SCRIPT
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${MYSQL_ROOT_PASS}';
FLUSH PRIVILEGES;
MYSQL_SCRIPT

# Create DB and user (only for localhost access)
echo "🛠 Creating MySQL database and local user..."
sudo mysql -uroot -p"${MYSQL_ROOT_PASS}" <<MYSQL_SCRIPT
DROP DATABASE IF EXISTS ${DB_NAME};
CREATE DATABASE ${DB_NAME};
DROP USER IF EXISTS '${DB_USER}'@'localhost';
CREATE USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
MYSQL_SCRIPT

# Install Node.js LTS
echo "📦 Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs

# Configure UFW
echo "🛡 Configuring UFW firewall rules..."
sudo ufw allow 'Nginx Full'
sudo ufw allow 22
sudo ufw allow 3000  # Allow HTTP traffic
sudo ufw allow ${API_PORT}
sudo ufw deny 3306  # 🚫 Deny public access to MySQL
sudo ufw --force enable

# Detect PHP-FPM socket
PHP_FPM_SOCK=$(find /var/run/php -name "php*-fpm.sock" | head -n 1)

# Optional: Install phpMyAdmin (with IP restriction)
echo "📦 Installing phpMyAdmin with IP restriction..."
# Remove existing phpMyAdmin to avoid "Directory not empty" errors
sudo rm -rf $PHPMYADMIN_DIR
sudo mkdir -p $PHPMYADMIN_DIR

LATEST_URL=$(curl -s https://www.phpmyadmin.net/downloads/ | grep -oP 'https://files.phpmyadmin.net/phpMyAdmin/\d+\.\d+\.\d+/phpMyAdmin-\d+\.\d+\.\d+-all-languages.zip' | head -n 1)
wget -O /tmp/phpmyadmin.zip "$LATEST_URL"
sudo unzip -q /tmp/phpmyadmin.zip -d /tmp/
sudo mv /tmp/phpMyAdmin-*-all-languages/* $PHPMYADMIN_DIR
sudo rm -rf /tmp/phpmyadmin.zip /tmp/phpMyAdmin-*-all-languages

# Replace YOUR.IP.HERE with your real IP address
ALLOWED_IP="13.203.241.137"

# Configure Nginx for API
echo "⚙️ Setting up Nginx for API..."
sudo tee /etc/nginx/sites-available/email-server > /dev/null <<EOL
server {
    listen 80;
    server_name ${API_DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOL

# Configure Nginx for phpMyAdmin with IP restriction
echo "⚙️ Setting up Nginx for phpMyAdmin with IP restriction..."
sudo tee /etc/nginx/sites-available/db-server > /dev/null <<EOL
server {
    listen 80;
    server_name ${DB_DOMAIN};

    root ${PHPMYADMIN_DIR};
    index index.php index.html index.htm;

    location / {
        allow ${ALLOWED_IP};
        deny all;
        try_files \$uri \$uri/ =404;
    }

    location ~ \.php\$ {
        allow ${ALLOWED_IP};
        deny all;
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${PHP_FPM_SOCK};
        fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        include fastcgi_params;
    }
}
EOL

# Enable Nginx sites
sudo ln -sf /etc/nginx/sites-available/email-server /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/db-server /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# SSL certificates
echo "🔐 Installing SSL certificates..."
sudo certbot --nginx -d ${API_DOMAIN} --non-interactive --agree-tos -m ${ADMIN_EMAIL}
sudo certbot --nginx -d ${DB_DOMAIN} --non-interactive --agree-tos -m ${ADMIN_EMAIL}

# Auto-renew SSL
echo "🕒 Enabling SSL auto-renew with cron..."
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | crontab -

# Install PM2 if missing
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installing PM2..."
    sudo npm install -g pm2
fi

# Setup Project
if [ ! -d "$PROJECT_DIR" ]; then
    echo "📂 Cloning project..."
    sudo git clone https://github.com/itsarbaz51/email-server-api.git $PROJECT_DIR
fi

cd $PROJECT_DIR
sudo npm install

# Create .env file for Prisma
echo "📄 Creating .env file for Prisma..."
cat <<EOL > .env
DATABASE_URL="mysql://${DB_USER}:${DB_PASS}@localhost:3306/${DB_NAME}"
EOL

# Export DATABASE_URL for current shell
export DATABASE_URL="mysql://${DB_USER}:${DB_PASS}@localhost:3306/${DB_NAME}"

# Prisma migrate
echo "📦 Running Prisma migrations..."
npx prisma migrate deploy

# Restart API with PM2
echo "🚀 Starting API with PM2..."
pm2 delete email-server || true
pm2 start src/index.js --name email-server
pm2 save
pm2 startup systemd -u $USER --hp $HOME

echo "✅ Setup Complete!"
echo "🌐 API: https://${API_DOMAIN}"
echo "🗄 DB Panel (restricted): https://${DB_DOMAIN}"
