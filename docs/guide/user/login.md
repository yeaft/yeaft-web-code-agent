# Login & Registration

The Yeaft Web UI starts at the login page. Only after logging in do you see the sidebar, Agent list, Workbench and all the other features.

## Login

1. Open your server URL (e.g. `https://yeaft.example.com`)
2. Enter **username** and **password**
3. If TOTP (two-factor) is enabled:
   - **First login**: a QR code is shown — scan it with Google Authenticator / Authy / 1Password and enter the 6-digit code
   - **Subsequent logins**: open the authenticator app and type the current 6-digit code
4. If email verification is configured, enter the code sent to your inbox

> The server's auth switch is governed by `ENABLE_AUTH` at deployment time. In dev you can use `skipAuth` to go straight through.

## Registration

Public registration is **off by default** — you need an invite code from an admin:

1. On the login page click **"Register new account"**
2. Fill in:
   - **Username** (≥2 characters)
   - **Password** (≥6 characters)
   - **Confirm password**
   - **Email** (optional — used for verification emails / password recovery if mail is set up)
   - **Invite code** (admins create these under Settings → Invite codes)
3. Click **Submit**
4. After success you're redirected to the login page

> Invite codes can be single-use or multi-use (admin's choice) with optional expiry. Used or expired codes cannot be redeemed again.

## Change password

Settings → Security → Change password:

1. Enter current password
2. Enter new password (≥6 chars)
3. Confirm new password
4. Click **Change password**

The current session is **not auto-logged-out**, but other devices will need the new password next time.

## Forgot password

If email sending is configured:

1. Login page → **Forgot password**
2. Enter the email you registered with
3. Open the email, click the link, set a new password

If no email was set, **contact an admin** to reset it from the dashboard.

## Multiple accounts / roles

- **Pro** — regular user; can create sessions, use any backend, manage their own Agents
- **Admin** — administrator; can issue invite codes, view the dashboard, manage global config

The admin account is usually the first one created; subsequent accounts join via invite. The role is fixed at invite-creation time.

## Logout

Settings → Account → **Sign out**.

The token is invalidated and you go back to the login page.
