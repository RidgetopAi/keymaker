# Keymaker VPS Deployment Guide

## Prerequisites on VPS

```bash
# Check available RAM (need 4GB+ for Ollama)
free -h

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PostgreSQL + pgvector
sudo apt install -y postgresql postgresql-contrib
sudo apt install -y postgresql-16-pgvector  # or appropriate version

# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull llama3.2:3b
ollama pull nomic-embed-text
```

## Deploy Keymaker

```bash
# Clone repository
cd /home/ridgetop
git clone [repo-url] keymaker
cd keymaker

# Install dependencies
npm install

# Create production database
createdb keymaker_production
psql keymaker_production < schema/mvk.sql

# Configure environment
cp deploy/.env.template .env
nano .env  # Set KEYMAKER_TOKEN

# Install systemd service
sudo cp deploy/keymaker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable keymaker
sudo systemctl start keymaker

# Check status
sudo systemctl status keymaker
journalctl -u keymaker -f
```

## Configure SSL

```bash
# Install nginx + certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Copy nginx config
sudo cp deploy/nginx-keymaker.conf /etc/nginx/sites-available/keymaker
sudo ln -s /etc/nginx/sites-available/keymaker /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Get SSL certificate
sudo certbot --nginx -d keymaker.ridgetopai.com
```

## Test Deployment

```bash
# Local test
curl -X GET http://localhost:3001/api/health

# Authenticated test
curl -X GET https://keymaker.ridgetopai.com/api/health \
  -H "x-keymaker-token: YOUR_TOKEN"

# Store observation
curl -X POST https://keymaker.ridgetopai.com/api/observe \
  -H "Content-Type: application/json" \
  -H "x-keymaker-token: YOUR_TOKEN" \
  -d '{"content": "Test from VPS deployment"}'
```

## Data Migration (Optional)

To migrate observations from local to VPS:

```bash
# On local machine - export
pg_dump -h localhost keymaker_production -t observations > observations.sql

# On VPS - import
psql keymaker_production < observations.sql
```

## Monitoring

```bash
# View logs
journalctl -u keymaker -f

# Check Ollama
curl http://localhost:11434/api/tags

# Check database
psql keymaker_production -c "SELECT COUNT(*) FROM observations;"
```
