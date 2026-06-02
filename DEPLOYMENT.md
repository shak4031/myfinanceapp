# Deployment Guide - MyFinanceApp V2

## 🚀 Quick Deploy to Railway (5 minutes)

### Prerequisites
- GitHub account
- Railway account (https://railway.app)
- Domain: myfinanceapp.us (already registered)

---

## Step 1: Create GitHub Repository

```bash
cd /opt/data/myfinanceapp-v2

# Initialize repo (if not done)
git init
git add .
git commit -m "Initial release"

# Create repo on GitHub via web UI
# https://github.com/new
# Name: myfinanceapp
# Visibility: private (or public)

# Add remote
git remote add origin https://github.com/YOUR_USERNAME/myfinanceapp.git
git branch -M main
git push -u origin main
```

---

## Step 2: Connect to Railway

1. Go to https://railway.app
2. Sign in with GitHub
3. Click "New Project"
4. Click "Deploy from GitHub repo"
5. Select `myfinanceapp` repository
6. Railway auto-detects Node.js
7. Click "Deploy"

---

## Step 3: Configure Environment

In Railway dashboard:

**Variables:**
```
PORT=8080  (Railway provides this)
NODE_ENV=production
```

**Build Command:**
```
npm install
```

**Start Command:**
```
node backend/server.js
```

---

## Step 4: Connect Custom Domain

1. In Railway dashboard → Settings → Domain
2. Click "Add Custom Domain"
3. Enter: `myfinanceapp.us`
4. Railway gives you nameservers
5. Update domain registrar with nameservers
6. Wait 24-48 hours for DNS propagation

---

## Step 5: Persistent Volume (Optional)

If you want database to persist:

In Railway dashboard → Variables → Add:

```
DATABASE_URL=/var/data/myfinanceapp-v2.db
```

Then update backend/db.js:
```javascript
this.dbPath = process.env.DATABASE_URL || '/opt/data/myfinanceapp-v2.db';
```

---

## ✅ Verification

After deployment:

```bash
# Should return HTML
curl https://myfinanceapp.us/

# Should return JSON
curl -X POST https://myfinanceapp.us/api/dashboard/summary

# Check logs
railway logs  # in CLI
```

---

## 🔒 HTTPS

Railway handles HTTPS automatically. Your app will:
- ✅ Run on https://myfinanceapp.us
- ✅ Force HTTPS
- ✅ Have SSL certificate

---

## 💾 Database Persistence

Current setup:
- Database file: `/opt/data/myfinanceapp-v2.db`
- On Railway: Survives redeploys if mounted as persistent volume

Railway persistent volume:
1. Add volume in Railway dashboard
2. Mount to `/var/data/`
3. Update DB path in code

---

## 📊 Monitoring

Railway provides:
- ✅ Auto-scaling
- ✅ Health checks
- ✅ Logs
- ✅ Metrics
- ✅ Uptime monitoring

---

## 🔄 Continuous Deployment

After setup:

```bash
# Make changes locally
git add .
git commit -m "Feature: Add something"
git push origin main

# Railway auto-deploys within 30 seconds
```

---

## 🆘 Troubleshooting

**App won't start:**
```bash
# Check logs in Railway dashboard
# Common: PORT not set, NODE_ENV issues
```

**Database not persisting:**
```bash
# Use Railway persistent volume
# Or switch to PostgreSQL (managed by Railway)
```

**Domain not working:**
```bash
# DNS can take 24-48 hours
# Check propagation: https://dnschecker.org
```

---

## 💡 Next Steps

1. **Push to GitHub** (Step 1)
2. **Deploy on Railway** (Steps 2-3)
3. **Configure domain** (Step 4)
4. **Test live** at https://myfinanceapp.us
5. **Add features** as needed

---

## 📝 Current Production Ready

Your app is **already production-ready**:
- ✅ Error handling
- ✅ Logging
- ✅ Database seeded
- ✅ APIs working
- ✅ Frontend polished

Just push to deploy! 🚀
