# Daily Care

Daily Care is a mobile-first PWA for tracking flexible daily and weekly routines. It ships with Creatine Reminder and Medication Reminder categories, and the admin panel can create more categories with custom routine names, times, and recurrence. Each category has its own check-in state and history. Reminder times, per-routine toggles, and extra reminders belong to each app's push subscription rather than the shared check-in state.

## Local development

```sh
npm install
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... npm start
```

Open `http://localhost:3005`. Push notifications require HTTPS in a real browser and a VAPID key pair. The deployment script generates the keys automatically.

Useful environment variables:

- `PORT`: listening port, default `3005`.
- `DATA_DIR`: persistent state directory, default `./data`.
- `APP_TIMEZONE`: IANA timezone used for the 5:00 AM reset and reminder scheduler.
- `RESET_HOUR`: reset hour, default `5`.
- `DEFAULT_MORNING_TIME`, `DEFAULT_MIDDAY_TIME`, `DEFAULT_EVENING_TIME`: fallback reminder times.

## VPS deployment

Run the installer from the project directory on a Debian/Ubuntu VPS with Caddy already installed:

```sh
sudo ./deploy/install.sh
```

It installs dependencies, creates the `dailycare` systemd service on port `3005`, generates VAPID keys, and adds the `dailycare.1113112.xyz` Daily Care Caddy block. Set `APP_TIMEZONE` before running it or edit the generated environment file afterward and restart the service.

If the existing Caddyfile lives elsewhere:

```sh
sudo CADDYFILE=/path/to/Caddyfile ./deploy/install.sh
```
