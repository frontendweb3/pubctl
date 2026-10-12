# Cloud Storage Configuration Guide (S3, Cloudflare R2, MinIO)

`pubctl` supports offloading Ghost CMS media assets (images, videos, audio, file downloads) to S3-compatible cloud storage providers. Offloading media prevents your virtual server's local disk from bloating and simplifies multi-tenant backups.

---

## Architecture Overview

When you run `pubctl create` with `--storage s3`, the following environment variables are injected into the Ghost container:

```ini
storage__active=s3
storage__s3__bucket=<bucket-name>
storage__s3__accessKeyId=<access-key-id>
storage__s3__secretAccessKey=<secret-access-key>
storage__s3__region=<region>
storage__s3__endpoint=<custom-endpoint-url>      # Optional
storage__s3__assetHost=<custom-cdn-domain>        # Optional
storage__s3__forcePathStyle=true                 # Optional (for MinIO)
```

Ghost CMS does not include the S3 storage adapter in its default base image. For Ghost to activate the adapter, the package `ghost-storage-adapter-s3` must be installed inside the container at:
```
/var/lib/ghost/content/adapters/storage/s3/index.js
```

---

## 1. Building the Custom Ghost Image

Use the provided [Dockerfile.ghost-s3](../Dockerfile.ghost-s3) in the repository root to build an image with the adapter pre-installed:

```dockerfile
ARG GHOST_VERSION=6-alpine
FROM ghost:${GHOST_VERSION}

ENV ADAPTER_DIR=/var/lib/ghost/content/adapters/storage/s3

USER root

RUN mkdir -p ${ADAPTER_DIR} && \
    cd ${ADAPTER_DIR} && \
    npm init -y && \
    npm install --no-save ghost-storage-adapter-s3 && \
    echo "module.exports = require('ghost-storage-adapter-s3');" > ${ADAPTER_DIR}/index.js && \
    chown -R node:node /var/lib/ghost/content

USER node
EXPOSE 2368
CMD ["node", "current/index.js"]
```

### Build & Tag:
```bash
# Ghost 6 (Default):
docker build -t my-ghost-s3:6-alpine -f Dockerfile.ghost-s3 .

# Ghost 5 (Legacy):
docker build --build-arg GHOST_VERSION=5-alpine -t my-ghost-s3:5-alpine -f Dockerfile.ghost-s3 .
```

---

## 2. Provider Setup Guides

### A. Cloudflare R2

Cloudflare R2 offers zero egress fees, making it an ideal choice for Ghost media assets.

1. **Create an R2 Bucket**:
   - Go to Cloudflare Dashboard → **R2** → **Create bucket** (e.g., `ghost-r2-media`).
2. **Create API Tokens**:
   - Go to **Manage R2 API Tokens** → **Create API Token**.
   - Set Permissions: **Object Read & Write**.
   - Note the **Access Key ID**, **Secret Access Key**, and **Endpoint URL** (format: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
3. **Connect a Custom Domain** (Optional but Recommended):
   - Under bucket settings, click **Connect Domain** and set a subdomain (e.g., `media.example.com`).
4. **Deploy with `pubctl`**:
   ```bash
   pubctl create \
     --name blog \
     --domain blog.example.com \
     --admin-email admin@example.com \
     --version my-ghost-s3:6-alpine \
     --storage s3 \
     --s3-bucket ghost-r2-media \
     --s3-key <R2_ACCESS_KEY_ID> \
     --s3-secret <R2_SECRET_ACCESS_KEY> \
     --s3-endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
     --s3-asset-host https://media.example.com \
     --s3-region auto
   ```

---

### B. Amazon AWS S3

1. **Create an S3 Bucket**:
   - Create a bucket in your desired AWS region (e.g., `us-east-1`).
   - Uncheck **Block all public access** if you plan to serve images directly from S3 (or configure a CloudFront distribution).
2. **Create IAM User & Policy**:
   - Create an IAM user with programmatic access.
   - Attach the following policy:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Effect": "Allow",
           "Action": [
             "s3:PutObject",
             "s3:GetObject",
             "s3:DeleteObject"
           ],
           "Resource": "arn:aws:s3:::my-ghost-bucket/*"
         }
       ]
     }
     ```
3. **Deploy with `pubctl`**:
   ```bash
   pubctl create \
     --name blog \
     --domain blog.example.com \
     --admin-email admin@example.com \
     --version my-ghost-s3:6-alpine \
     --storage s3 \
     --s3-bucket my-ghost-bucket \
     --s3-key <AWS_ACCESS_KEY_ID> \
     --s3-secret <AWS_SECRET_ACCESS_KEY> \
     --s3-region us-east-1
   ```

---

### C. MinIO (Self-Hosted S3)

When using MinIO or private S3-compatible storage appliances:
- Always supply `--s3-force-path-style` (MinIO requires path-style routing: `http://minio/bucket/file` instead of subdomain-style `http://bucket.minio/file`).

```bash
pubctl create \
  --name blog \
  --domain blog.example.com \
  --admin-email admin@example.com \
  --version my-ghost-s3:6-alpine \
  --storage s3 \
  --s3-bucket ghost-uploads \
  --s3-key <MINIO_ROOT_USER> \
  --s3-secret <MINIO_ROOT_PASSWORD> \
  --s3-endpoint https://minio.yourdomain.com \
  --s3-force-path-style
```

---

### D. DigitalOcean Spaces

1. Create a Space in your chosen region (e.g., `nyc3`).
2. Generate a Spaces Access Key and Secret Key.
3. Deploy:
   ```bash
   pubctl create \
     --name blog \
     --domain blog.example.com \
     --admin-email admin@example.com \
     --version my-ghost-s3:6-alpine \
     --storage s3 \
     --s3-bucket my-space-name \
     --s3-key <DO_SPACES_KEY> \
     --s3-secret <DO_SPACES_SECRET> \
     --s3-endpoint https://nyc3.digitaloceanspaces.com \
     --s3-region nyc3
   ```
