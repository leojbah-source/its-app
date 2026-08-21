# Deploying ITS to Render (for testing)

This puts the whole app online at one web address you can share with your tester.
It stays up even when your PC is off. Everything below is copy‑paste; you do not
need to understand the code. Do the parts **in order**.

Rough time: 30–45 minutes, most of it waiting for Render to build.

---

## Part 0 — Push your code to GitHub (fixes the 55 un‑pushed commits)

Open **Command Prompt** (press Start, type `cmd`, Enter) and run these one at a
time:

```
cd C:\ITS-APP
del .git\index.lock
git add -A
git commit -m "chore: single-origin serving + Render deploy config"
git push
```

Notes:
- `del .git\index.lock` removes a stale lock file. If it says "Could Not Find",
  that's fine — carry on.
- `git commit` may say *nothing to commit* if it was already committed — that's
  fine too.
- `git push` is the important one. It uploads all your work (the 55 earlier
  commits **plus** today's) to GitHub. If it asks you to sign in, sign in to the
  GitHub account **leojbah-source**.

When `git push` finishes without red errors, your code is safely on GitHub.

---

## Part 1 — Make a Render account (free)

1. Go to **https://render.com** and click **Get Started**.
2. Choose **Sign in with GitHub** and approve access to your repositories.
   (This lets Render read the `its-app` repo. It cannot change your code.)

---

## Part 2 — Create everything from the blueprint

1. In Render, click **New +** (top right) → **Blueprint**.
2. Pick the repository **leojbah-source/its-app**.
3. Render finds the `render.yaml` file and shows it will create:
   - a database **its-db**
   - a web service **its-app**
4. Click **Apply**.
5. Wait. The first build takes ~5–10 minutes (it builds the website, then starts
   the server). You can watch the log; when the web service shows **Live**
   (green), it's running.

Your app address will look like **https://its-app.onrender.com** (Render shows
the exact one on the its-app service page, top left). Open it — the app loads,
but it will be **empty** until you do Part 3.

> Free plan note: after ~15 minutes with nobody using it, the service "sleeps".
> The next click wakes it and takes ~30–60 seconds to load. That's normal on the
> free plan — just tell your tester the first click of the day is slow.

---

## Part 3 — Copy your test data into the cloud database

Your local database `its_app` already has your test data. We copy it up once.

**3a. Make a copy of your local database into a file.** In Command Prompt:

```
cd C:\ITS-APP
pg_dump --no-owner --no-acl -h localhost -p 5432 -U postgres -d its_app -f its_dump.sql
```

It will ask for your local Postgres password (the one in `backend\.env`). Type
it (nothing shows as you type) and press Enter. This creates `its_dump.sql` in
`C:\ITS-APP`.

> If Windows says `pg_dump is not recognized`, it just isn't on your PATH. Use
> the full path instead, e.g.
> `"C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" --no-owner --no-acl -h localhost -p 5432 -U postgres -d its_app -f its_dump.sql`
> (change `16` to your installed version number).

**3b. Get the cloud database's address.** In Render → **its-db** → **Connect** →
copy the **External Database URL**. It looks like:
`postgresql://kca_its_user:LONGPASSWORD@dpg-xxxxx.frankfurt-postgres.render.com/kca_its`

**3c. Load your data into the cloud database.** In Command Prompt, paste the URL
inside the quotes (add `?sslmode=require` at the end):

```
"C:\Program Files\PostgreSQL\18\bin\psql.exe" "PASTE_YOUR_EXTERNAL_DATABASE_URL_HERE" -f "%USERPROFILE%\its_dump.sql"
```

It runs for a minute and scrolls a lot of `CREATE TABLE`, `COPY`, etc. When it
finishes and returns to the prompt, your cloud app has all your data.

Refresh your app address from Part 2 — it now shows your events, participants,
etc.

---

## Part 4 — Hand it to your tester

Open **TESTER-GUIDE.md**, fill in the blanks at the top (your app address and a
few test logins), and send that to your tester. That's all they need.

---

## If something goes wrong

- **Build failed (red) in Render:** click the failed build to see the log. The
  most common cause is the website build step. Copy the last ~20 red lines and
  send them to me.
- **App loads but everything is empty:** Part 3 didn't run or didn't finish —
  re-run 3c.
- **"password authentication failed" during `psql`:** you pasted the wrong URL —
  re-copy the **External** Database URL from Render (not the internal one).
- **Judges can't get an OTP:** that's expected — OTP is turned off for testing
  (`JUDGE_OTP_BYPASS=true`), so judges log in with just their phone number.
- **You changed code later:** run the four commands in Part 0 again
  (`git add -A`, `git commit -m "..."`, `git push`). Render redeploys
  automatically within a minute.

---

### Alternative: start with an empty database (only if you do NOT want your local data)
Instead of Part 3, connect to the cloud DB and load the schema, then migrations:
```
psql "EXTERNAL_URL?sslmode=require" -f db\schema.sql
```
then set the same DB values from Render into `backend\.env` and run
`cd backend && npm run migrate`. You'll then have empty tables and must create an
admin user and data by hand — which is why copying your local data (Part 3) is
the recommended path.
