# Delshiv AI — GitHub Release Guide

## 1. Repository Configuration
`package.json` me `build.publish` configured hai:
```json
"publish": [
  {
    "provider": "github",
    "owner": "sr3139757-code",
    "repo": "Delshiv-AI",
    "releaseType": "release"
  }
]
```

## 2. Naya Version Release Karne Ke Exact Steps
Jab bhi naya update release karna ho (e.g. `1.0.0` → `1.0.1`):

1. **Main branch par rahein:**
   ```powershell
   git checkout main
   git pull origin main
   ```
2. **Version update karein (`package.json`):**
   - `package.json` me `"version": "1.0.1"` karein (ya `npm version patch --no-git-tag-version` chalayein).
3. **Commit & Push to `main`:**
   ```powershell
   git add package.json package-lock.json
   git commit -m "chore: release v1.0.1"
   git push origin main
   ```
4. **Release Tag banayein aur Push karein:**
   ```powershell
   git tag v1.0.1
   git push origin v1.0.1
   ```
5. **Automatic Build & Upload:**
   - Tag push hote hi GitHub Actions workflow (`.github/workflows/release.yml`) automatically Windows NSIS installer (`Delshiv AI Setup 1.0.1.exe`), `.blockmap`, aur `latest.yml` build karega aur `v1.0.1` GitHub Release me upload kar dega.

## 3. Private Repository Ke Liye Token Security
- **GitHub Actions me:** Workflow built-in `${{ secrets.GITHUB_TOKEN }}` (`permissions: contents: write`) use karta hai — aapko koi extra secret ya PAT code me nahi rakhna padta.
- **Agar repo Private hai aur local/CI se access chahiye:**
  1. GitHub par **Fine-grained Personal Access Token (PAT)** banayein aur sirf usi repository ke liye **Contents: Read & Write** (publish ke liye) ya **Contents: Read-only** (future download ke liye) permission dein, aur expiry set karein.
  2. Token ko **kabhi bhi** `package.json`, `.env`, ya kisi source file me hardcode/commit na karein.
  3. Local publish ke liye sirf terminal session variable use karein:
     ```powershell
     $env:GH_TOKEN="github_pat_..."
     ```
  4. CI me custom token chahiye ho to hamesha **GitHub Repo → Settings → Secrets and variables → Actions** me `GH_TOKEN` secret ke roop me save karein.
