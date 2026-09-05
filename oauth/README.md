# OAuth probe (not currently used)

Lauremont's Google Workspace blocks unapproved third-party apps, so the Google
Classroom API path returns `access_not_configured` and the collector runs
through Claude in Chrome instead (see `../docs/collector-spec.md`).

Everything here is kept in case the school later allowlists the app.

- **GCP project:** `kids-classroom-reminders`
- **OAuth client:** `classroom-collector-desktop` (Desktop app, Testing status)
- **Client ID:** `321996577488-lh8hlhge8aq53duasm479t27ibobm9ln.apps.googleusercontent.com`
- **Test users:** the two students' school accounts (added in the Google Auth Platform console, not recorded here)
- **Scopes:** classroom.courses / announcements / coursework.me / courseworkmaterials — all `.readonly`

## If access is granted

```bash
pip3 install google-auth-oauthlib google-api-python-client
python3 classroom_probe.py grade6    # sign in as the Grade 6 school account
python3 classroom_probe.py grade3
```

Writes `raw_<label>.json` per kid and prints every course, announcement,
assignment and material with its `alternateLink` (the stable source URL).

> `credentials.json` is git-ignored. Do not commit it, and do not commit the
> `token_*.json` files the script writes.
