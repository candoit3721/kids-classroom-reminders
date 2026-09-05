#!/usr/bin/env python3
"""
Google Classroom API probe / first collector.

Usage:
  pip3 install google-auth-oauthlib google-api-python-client
  python3 classroom_probe.py grade6     # first run opens a browser for OAuth
  python3 classroom_probe.py grade3

Each kid gets their own token file (token_<label>.json). Sign in as the KID's
school account in the browser window that opens. The script then prints every
course, announcement, coursework item and material it can see, with source URLs,
and writes the same as raw_<label>.json so we can inspect/extract later.
"""
import json
import os
import sys
from datetime import datetime, timezone

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.announcements.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
    # Uncomment when we start reading attachment contents:
    # "https://www.googleapis.com/auth/drive.readonly",
]


def get_creds(label: str) -> Credentials:
    token_path = f"token_{label}.json"
    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists("credentials.json"):
                sys.exit("credentials.json not found - download the OAuth Desktop client JSON first.")
            flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
            # Opens the default browser; sign in as the KID's school account.
            creds = flow.run_local_server(port=0, prompt="consent")
        with open(token_path, "w") as f:
            f.write(creds.to_json())
    return creds


def list_all(request_fn, key, **kwargs):
    """Page through a Classroom list endpoint."""
    items, page_token = [], None
    while True:
        resp = request_fn(pageToken=page_token, **kwargs).execute()
        items.extend(resp.get(key, []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            return items


def main(label: str):
    creds = get_creds(label)
    svc = build("classroom", "v1", credentials=creds)

    out = {"label": label, "collected_at": datetime.now(timezone.utc).isoformat(), "courses": []}

    try:
        courses = list_all(svc.courses().list, "courses", courseStates=["ACTIVE"])
    except HttpError as e:
        sys.exit(f"Classroom API refused: {e}\n"
                 "If this is 403 / access_denied / admin_policy_enforced, the school domain blocks third-party apps.")

    print(f"\n=== {label}: {len(courses)} active course(s) ===")
    for c in courses:
        cid = c["id"]
        entry = {"id": cid, "name": c.get("name"), "section": c.get("section"),
                 "url": c.get("alternateLink"), "announcements": [], "coursework": [], "materials": []}
        print(f"\n# {c.get('name')}  ({c.get('alternateLink')})")

        for kind, fn, key in [
            ("announcements", svc.courses().announcements().list, "announcements"),
            ("coursework", svc.courses().courseWork().list, "courseWork"),
            ("materials", svc.courses().courseWorkMaterials().list, "courseWorkMaterial"),
        ]:
            try:
                items = list_all(fn, key, courseId=cid)
            except HttpError as e:
                print(f"  [{kind}] error: {e.status_code}")
                continue
            entry[kind] = items
            for it in items:
                title = it.get("title") or (it.get("text") or "")[:80].replace("\n", " ")
                due = it.get("dueDate")
                due_s = f"  due {due['year']}-{due['month']:02d}-{due['day']:02d}" if due else ""
                atts = [m.get("driveFile", {}).get("driveFile", {}).get("title")
                        or m.get("link", {}).get("title")
                        or m.get("youtubeVideo", {}).get("title")
                        or m.get("form", {}).get("title")
                        for m in it.get("materials", [])]
                print(f"  [{kind}] {title}{due_s}")
                print(f"      posted {it.get('creationTime')}  src {it.get('alternateLink')}")
                if atts:
                    print(f"      attachments: {atts}")

        out["courses"].append(entry)

    raw_path = f"raw_{label}.json"
    with open(raw_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nSaved {raw_path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: classroom_probe.py <label>   e.g. grade6 or grade3")
    main(sys.argv[1])
