# ChargeDesk

A responsive charging-station desk app for tracking 60 sockets, checking gadgets in and out, recording payment, and using the existing socket QR cards.

## Requirements

- Node.js 22.13 or newer (Node 24 recommended) and npm.
- Locally: SQLite, included with Node.js.
- Online: a Vercel project connected to a Neon PostgreSQL database.

The app does not collect or store card numbers. QR codes are lookup tokens; staff must verify the gadget before release. The supplied socket cards have reusable QR codes that identify sockets, not individual jobs. Each job also receives a unique claim code for manual lookup.

## Run locally

In PowerShell, from the project folder:

```powershell
npm install
Copy-Item .env.example .env
```

Open `.env` and set `STAFF_PASSWORD` to a private passphrase of at least 16 characters. Generate a session secret with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set `SESSION_SECRET` to the generated value (at least 32 characters). Leave `DATABASE_URL` blank for local SQLite. Then run:

```powershell
npm run check
npm start
```

Open [http://localhost:3000](http://localhost:3000) and sign in. The first launch initializes 60 sockets and default settings for Just Electricals (NGN). Live and demo data are stored separately in `data/charging.sqlite` and `data/charging-demo.sqlite`. Keep `data` backed up; these files are not used by Vercel.

Set `PORT` to change the local port or `DATA_DIR` to choose another local data folder. `npm run dev` restarts the server when source files change.

## Using the app

1. **Dashboard:** See all 60 sockets. Return out-of-service sockets to service when ready. An occupied socket cannot be taken out of service.
2. **New charge:** Enter a customer name or reference and gadget description. Let the app assign an available socket or choose one, set the price, and optionally add notes.
3. **Claim card:** Give the customer the preprinted QR card for the assigned socket. The scanner finds that socket's active job; the QR does not contain customer, job, or payment details. The app creates a unique random claim code as a manual lookup fallback.
4. **Scan and collect:** Scan the socket QR using a phone camera over HTTPS (or localhost), or enter the claim code. Verify that the gadget matches, then record the payment method and amount and complete collection.
5. **History:** Search jobs and filter active, collected, or cancelled records.
6. **Settings:** Change business name, ISO currency code, default/minimum prices, and accepted payment methods. Collection requires payment at least equal to the job price.
7. **Demo mode:** Switch on Demo mode to try seeded sample jobs without changing live records. Demo records are stored separately from live records.

The PDF of the supplied socket cards is deliberately excluded from deployment and source control because it contains payment details. Use the existing printed cards; do not upload or share that PDF publicly.

## Deploy to Vercel with Neon

Vercel's application filesystem is not persistent, so online data uses PostgreSQL. Neon is connected through Vercel Marketplace and provides the `DATABASE_URL` setting. The app initializes its schema and 60 online sockets automatically on first request. The online database starts empty except for separate demo-mode sample records; local SQLite records are not imported.

1. **Push this project to GitHub.** Use a private repository. Do not upload `.env`, `data/`, SQLite database files, `node_modules/`, or `public/socket-cards.pdf`; the ignore files already exclude them. This project folder may need to be initialized and pushed to the GitHub repository before it can be imported.
2. **Import the repository into Vercel.** Create a Vercel project from the GitHub repository and deploy the default Express app. No custom build command is required.
3. **Connect Neon.** In the Vercel project, open the Marketplace/Storage integrations, add Neon, and link its PostgreSQL database to the project. Confirm `DATABASE_URL` is available for the Production environment.
4. **Set production secrets in Vercel.** In Project Settings → Environment Variables, add:
   - `STAFF_PASSWORD`: a new, private passphrase of at least 16 characters.
   - `SESSION_SECRET`: generate a random value using the command in the local setup section; use at least 32 characters.
   Do not commit these values or send them in chat. Redeploy after adding or changing environment variables.
5. **Test the deployed site.** Open the Vercel HTTPS URL, sign in, try Demo mode, then confirm a live job can be created and collected. Open it on a phone; camera access requires HTTPS and browser permission.
6. **Optional custom domain.** Add your business domain in Vercel project settings and follow its DNS instructions.

Check Vercel and Neon plans, usage limits, terms, and billing before making the app available to customers; do not assume usage will remain free. Neon is the production system of record, so arrange database backups and restrict production database access. The database URL and staff secrets must remain in Vercel's encrypted environment settings, not in source files.
