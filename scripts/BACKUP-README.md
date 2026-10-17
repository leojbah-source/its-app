# Database backups & data safety — Indian Talent Scan (TalentHub)

Your real data lives in the **Render managed PostgreSQL database**, which is
separate from the web service. Redeploying the app does **not** touch the data
in that database. (The one thing that was erasing data on every deploy —
two migrations that wiped scores and MC/Timer assignments — has been fixed.)

Keep two layers of protection:

## 1. Render automated backups (primary safety net)

1. In the Render dashboard, open the **its-app (production)** PostgreSQL
   database -> **Backups** (or **Recovery**) tab.
2. Confirm **daily backups** are enabled. On the paid instance you should also
   see **Point-in-Time Recovery (PITR)** — enable it if available. PITR lets
   you restore the database to any minute in the recent past, which is the best
   protection during the live event.
3. Note the retention period shown there.

This runs automatically — nothing to do each day once it's on.

## 2. Manual snapshots you control (run with `scripts\backup-db.ps1`)

Take a manual dump to your own PC:

- **Before every deploy.**
- At the **start and end of each event day.**
- Any time before a big change (schedule regenerate, consolidation, etc.).

### One-time setup
1. Render -> its-app production Postgres -> copy the **External Database URL**.
2. In PowerShell, run once (then reopen PowerShell):
   ```
   setx PROD_DATABASE_URL "postgres://....external...."
   ```

### Take a backup
```
cd C:\ITS-APP
powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
```
The dump lands in `C:\ITS-APP\backups\its-prod-YYYYMMDD-HHMMSS.dump`.
The `backups\` folder is git-ignored, so backups are never pushed to GitHub.
(These files contain personal data — keep them private.)

### (Optional) automatic daily local backup
Windows Task Scheduler -> Create Basic Task -> Daily -> Action "Start a program":
- Program: `powershell`
- Arguments: `-ExecutionPolicy Bypass -File C:\ITS-APP\scripts\backup-db.ps1`

## 3. Restoring from a dump (only if you ever need it)

**Restoring overwrites the target database — be careful which one you point at.**
Test a restore into a scratch database first if you can.

```
pg_restore --clean --no-owner --no-acl --dbname "<target database URL>" "C:\ITS-APP\backups\its-prod-YYYYMMDD-HHMMSS.dump"
```

If you're unsure, take a fresh backup first, then ask for help before restoring.
