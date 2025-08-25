# WhatsApp Calculator Bot v7 Final

## Features
- Per-group totals stored in PostgreSQL
- Continue calculations from last saved value
- Commands: !total, !reset
- Ignores multi-line messages and plain numbers
- Nepali-style number formatting (2 decimals)
- Prevents duplicate replies
- Auto-creates required tables in Postgres

## Deployment (Railway)
1. Push this repo to GitHub
2. Railway → New Project → Deploy from GitHub
3. Service Type: Worker
4. Variables:
   - `DATABASE_URL` (auto from Postgres service)
   - `DECIMALS=2`
   - `TZ=Asia/Kathmandu`
5. Done! Open Logs → scan QR → bot is live 24/7