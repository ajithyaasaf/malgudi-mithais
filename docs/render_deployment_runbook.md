# Malgudi Mithais POS — Central API Render Deployment Runbook

**Target Service:** Central Sync API (`@malgudi/api`)  
**Deployment Platform:** Render (Web Service + Persistent Disk)  
**Database:** SQLite WAL on Render Persistent Mount (`/var/data/malgudi-api/`)  
**Desktop Client Target:** Malgudi Mithais POS v2.9.8  

---

## 1. Overview & Architecture

The Central Cloud Sync API provides authoritative synchronization and consolidated reporting for two retail branches:
- **Branch IB:** Madurai Town Hall Main Store
- **Branch MN:** Mattuthavani Bus Stand Branch

Each branch POS installation runs offline-first with its own local SQLite database. The central API runs on Render as a single-instance Node.js service using SQLite WAL stored on a dedicated Render persistent disk mount.

```
  [Branch IB POS Desktop]             [Branch MN POS Desktop]
   (Local SQLite WAL)                  (Local SQLite WAL)
          │                                   │
          │ HTTPS Outbox Batch & Catalog Sync │
          └─────────────────┬─────────────────┘
                            │
                            ▼
              ┌───────────────────────────┐
              │ Render Web Service (Node) │
              │   0.0.0.0:$PORT           │
              │   /health (Liveness)      │
              └─────────────┬─────────────┘
                            │ Read/Write
                            ▼
              ┌───────────────────────────┐
              │ Render Persistent Disk    │
              │ /var/data/malgudi-api/    │
              │ malgudi_central_sync.db   │
              │ .db-wal & .db-shm         │
              └───────────────────────────┘
```

---

## 2. Render Web Service Specifications

| Setting | Value | Notes |
| :--- | :--- | :--- |
| **Service Type** | Web Service | Node.js environment |
| **Environment** | Node | Node 22 LTS or Node 24 |
| **Region** | Singapore (`singapore`) or closest | Lowest latency to Madurai, Tamil Nadu |
| **Branch** | `main` | Production branch |
| **Root Directory** | *(leave blank)* | Monorepo root |
| **Build Command** | `pnpm install` | Installs root and workspace dependencies |
| **Start Command** | `pnpm --filter @malgudi/api start` | Direct: `node --experimental-strip-types apps/api/src/index.ts` |
| **Plan Type** | Starter ($7/mo) or Standard | **Required:** Free tier does not support persistent disks |
| **Health Check Path**| `/health` | Zero-secret lightweight liveness probe |

---

## 3. Persistent Disk Configuration

> [!IMPORTANT]
> A persistent disk **must** be attached to the service. Without a persistent disk, SQLite database files will be wiped on every redeploy, restart, or container migration.

- **Disk Name:** `malgudi-sync-data`
- **Mount Path:** `/var/data/malgudi-api`
- **Size:** 1 GB (or 10 GB minimum standard on Render)

---

## 4. Required Environment Variables

Configure these variables in the Render Dashboard under **Environment**:

| Variable Name | Required Value | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Enforces fail-closed security and disables in-memory fallback |
| `NODE_VERSION` | `22` | Specifies Node.js 22 LTS runtime on Render |
| `MALGUDI_DATA_DIR` | `/var/data/malgudi-api` | Base directory for central SQLite database and WAL files |
| `MALGUDI_SYNC_API_KEY` | *(Secret: ≥32 characters)* | Bearer authentication token used by POS desktop terminals |
| `PORT` | *(Managed by Render)* | Render injects this automatically (e.g. 10000); API binds to `0.0.0.0:$PORT` |

> [!CAUTION]
> Generate a strong, high-entropy secret for `MALGUDI_SYNC_API_KEY` before deployment:
> ```bash
> openssl rand -hex 32
> ```
> Never commit this secret to Git or use the development test token (`malgudi_sync_secret_token_2026`).

---

## 5. Desktop Application Configuration

In the Malgudi Mithais POS desktop application (Settings -> Branch & Cloud Sync):

- **Cloud API URL:**  
  `https://<your-service-name>.onrender.com`  
  *(Do not add a trailing slash. Example: `https://malgudi-sync-api.onrender.com`)*
- **Cloud API Key:**  
  The exact secret configured in `MALGUDI_SYNC_API_KEY`.
- **Branch ID:**  
  `IB` (for Town Hall) or `MN` (for Mattuthavani).

The desktop POS client automatically routes to:
- Outbound Batch Sync: `POST /api/v1/sync/batch`
- Inbound Catalog Sync: `GET /api/v1/catalog/updates?since_version=<V>`
- Liveness Check: `GET /health` or `GET /api/v1/sync/health`

---

## 6. Step-by-Step Render Deployment Guide

### Step 1: Prepare Git Repository
Ensure all changes from this milestone are committed and pushed to your remote repository:
- `apps/api/src/index.ts` (Render compatibility, 0.0.0.0 host, configurable data dir, graceful shutdown, safe health routes)
- `apps/api/package.json` (`"start"` script)
- `package.json` (`"start:api"` script and engine requirements)
- `apps/api/tests/render-deployment.test.ts` (automated test suite)

### Step 2: Create Web Service on Render
1. Log into your [Render Dashboard](https://dashboard.render.com).
2. Click **New +** -> **Web Service**.
3. Select your Git repository containing `pos-billing`.
4. In the setup form:
   - **Name:** `malgudi-sync-api`
   - **Language:** `Node`
   - **Branch:** `main`
   - **Region:** `Singapore` (optimal latency for South India)
   - **Root Directory:** *(leave empty)*
   - **Build Command:** `pnpm install`
   - **Start Command:** `pnpm --filter @malgudi/api start`
   - **Instance Type:** Starter ($7/mo)

### Step 3: Attach Persistent Disk
1. Scroll down to the **Disks** section (or click **Disks** in the service navigation).
2. Click **Add Disk**.
3. Enter:
   - **Name:** `malgudi-sync-data`
   - **Mount Path:** `/var/data/malgudi-api`
   - **Size:** `1 GB` (or default 10 GB)

### Step 4: Add Environment Variables
In the **Environment Variables** section, add:
- `NODE_ENV` = `production`
- `NODE_VERSION` = `22`
- `MALGUDI_DATA_DIR` = `/var/data/malgudi-api`
- `MALGUDI_SYNC_API_KEY` = `<paste your 64-character secret>`

### Step 5: Configure Health Check
Under **Advanced**:
- **Health Check Path:** `/health`

### Step 6: Deploy & Verify
1. Click **Create Web Service**.
2. Monitor the Render deployment logs. Look for:
   ```
   [INFO] Malgudi Cloud Sync API listening on http://0.0.0.0:10000
   [INFO] Persistent storage: SQLite WAL at /var/data/malgudi-api/malgudi_central_sync.db
   ```
3. Once the deployment shows **Live**, verify health in your browser or terminal:
   ```bash
   curl -i https://<your-service-name>.onrender.com/health
   ```
   Expected response:
   ```json
   HTTP/2 200
   content-type: application/json

   {
     "status": "healthy",
     "service": "malgudi-central-sync-api",
     "version": "2.9.8",
     "timestamp": "2026-10-13T..."
   }
   ```
4. Configure the desktop POS client with the new HTTPS URL and test end-to-end sync!
