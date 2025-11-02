# Mie-Tech Chat Platform Deployment

This repository provides infrastructure files and instructions for deploying an open-source live chat platform for [mie.ngo](https://mie.ngo). The setup is based on [Chatwoot](https://www.chatwoot.com/), an open-source customer engagement suite that supports multi-channel chat, shared inboxes, and automation features.

## Repository Contents

- [`chatwoot-deployment/docker-compose.yml`](chatwoot-deployment/docker-compose.yml) &mdash; docker-compose stack for Chatwoot, PostgreSQL, and Redis.
- [`chatwoot-deployment/.env.example`](chatwoot-deployment/.env.example) &mdash; sample environment variables to copy to `.env` before deploying.
- [`integrations/squarespace-chatwoot-webhook`](integrations/squarespace-chatwoot-webhook) &mdash; sample Express service that relays Squarespace form submissions into a Chatwoot inbox.

## Prerequisites

Before deploying Chatwoot for mie.ngo, ensure the following prerequisites are met:

1. **Server** &mdash; Ubuntu 22.04 LTS (or compatible) virtual machine with at least 2 vCPUs, 4 GB RAM, and 40 GB disk.
2. **Domain names** &mdash; DNS `A` records pointing `mie.ngo` (marketing site) and `support.mie.ngo` (Chatwoot app) to the server's public IP.
3. **Docker tooling** &mdash; Docker Engine and Docker Compose plugin installed.
4. **Email credentials** &mdash; SMTP account capable of sending transactional email (for password resets and notifications).

## Installation Steps

1. **Clone the repository** on the server:
   ```bash
   git clone https://github.com/<your-org>/Mie-Tech.git
   cd Mie-Tech/chatwoot-deployment
   ```

2. **Install Docker and Docker Compose** (if not already installed):
   ```bash
   sudo apt update
   sudo apt install -y ca-certificates curl gnupg
   sudo install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
   echo \
     "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
     $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
   sudo apt update
   sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   ```

3. **Prepare environment variables**:
   ```bash
   cp .env.example .env
   nano .env
   ```
   Update secrets (`SECRET_KEY_BASE`, `POSTGRES_PASSWORD`, `SMTP_PASSWORD`, `SUPER_ADMIN_PASSWORD`) and adjust any organization-specific values.

4. **Launch the services**:
   ```bash
   docker compose up -d
   ```
   The first run will create the database, seed initial data, and start the Chatwoot web application on port `3000`.

5. **Access the admin UI**:
   - Navigate to `https://support.mie.ngo` (after configuring SSL) or `http://<server-ip>:3000` during testing.
   - Log in with the `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` defined in `.env`.
   - Create additional agents, configure inboxes, and connect channels (website live chat widget, WhatsApp, Facebook, etc.).

## SSL and Reverse Proxy (Recommended)

To serve Chatwoot securely from `https://support.mie.ngo`, configure a reverse proxy with HTTPS termination. Example using Nginx and Let's Encrypt:

1. Install Nginx and Certbot:
   ```bash
   sudo apt install -y nginx certbot python3-certbot-nginx
   ```

2. Obtain certificates:
   ```bash
   sudo certbot --nginx -d support.mie.ngo
   ```

3. Configure `/etc/nginx/sites-available/chatwoot.conf`:
   ```nginx
   server {
       server_name support.mie.ngo;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto https;
       }
   }
   ```

4. Enable the site and reload Nginx:
   ```bash
   sudo ln -s /etc/nginx/sites-available/chatwoot.conf /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

Certbot will automatically renew certificates; verify renewal by running `sudo certbot renew --dry-run`.

## Post-Installation Checklist

- [ ] Update the Chatwoot brand settings (logo, colors) for mie.ngo.
- [ ] Configure the website widget (Settings → Inboxes → Website) and embed the generated script into `mie.ngo`.
- [ ] Set up SMTP sender policies (SPF, DKIM, DMARC) for reliable email delivery.
- [ ] Create regular database backups (e.g., `pg_dump` cron job or managed backups).
- [ ] Monitor container health with tools such as Uptime Kuma or Grafana.

## Maintenance

- Apply Chatwoot updates by pulling the latest image and redeploying:
  ```bash
  docker compose pull
  docker compose up -d
  ```
- Rotate admin credentials and update `.env` regularly.
- Review Chatwoot release notes for breaking changes before upgrading.

## Support

If you encounter issues during deployment, consult the [Chatwoot documentation](https://www.chatwoot.com/docs) or open an issue in this repository with logs and reproduction steps.
