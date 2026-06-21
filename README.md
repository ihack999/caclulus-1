# Engineering Calculus 1 Self-Study Dashboard

This is a personal study dashboard built on top of the offline MIT OpenCourseWare 18.01SC Single Variable Calculus package.

It does not rewrite the MIT course content. It organizes the local OCW pages and PDFs into a cleaner Engineering Calculus 1 study flow with modules, lessons, practice links, solution links, exam prep, local progress tracking, command search, lesson notes, and ordered YouTube lesson clips.

## Run Locally

Simplest option:

1. Open `index.html` in your browser.
2. Use the sidebar search, module list, weekly plan, and lesson pages.
3. Progress checkboxes, saved YouTube overrides, collapsed sections, and lesson reflection notes are saved in your browser local storage.
4. Sign in with Supabase to sync that same study state across browsers.

Optional local server:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

Use the local server when testing Supabase auth. In the Supabase dashboard, add `http://localhost:8000/` to your Auth URL configuration if email confirmations or redirects are enabled.

## Supabase Sync Setup

1. Open your Supabase project SQL editor.
2. Run the SQL in `supabase-schema.sql`.
3. Confirm email/password auth is enabled in Supabase Auth.
4. Start this site with `python3 -m http.server 8000`.
5. Open `http://localhost:8000/`, click `Sign In`, and create an account.

The browser app uses `supabase-config.js`, which contains only the Supabase URL and publishable key. Do not put a Supabase secret key in this frontend. If a secret key has been pasted or shared, rotate it in Supabase before relying on the project.

## Main Files

- `index.html` - the dashboard shell.
- `styles.css` - dashboard styling.
- `app.js` - routing, command search, progress, guided lesson studio, YouTube clip playback, local notes, and rendering.
- `course-map.json` - generated course map with modules, lessons, PDFs, problem sets, solutions, exams, and exam solutions.
- `site-data.js` - browser-ready copy of the course map so `index.html` can open directly.
- `supabase-config.js` - public Supabase browser configuration.
- `supabase-schema.sql` - one-time database table and RLS setup for cloud sync.
- `scripts/generate_course_map.py` - regenerates `course-map.json` and `site-data.js` from `ocw-source/`.
- `scripts/import_youtube_links.py` - imports the ordered YouTube lesson list into `course-map.json` and `site-data.js`.
- `ocw-source/` - the original offline OCW course package.

## Regenerate The Map

If the OCW source files change, run:

```bash
python3 scripts/generate_course_map.py
```

This refreshes both:

```text
course-map.json
site-data.js
```

To re-import an ordered YouTube list, run:

```bash
python3 scripts/import_youtube_links.py /path/to/youtube-links.txt
```

The importer expects lesson headings like `Session 1: ...` followed by YouTube URLs. Exact clip start and end times are preserved when present.

## Study Path

The dashboard uses this recommended Engineering Calculus 1 flow:

1. Pre-calculus review
2. Limits
3. Derivatives
4. Derivative applications
5. Integrals
6. Integration techniques
7. Series
8. Exam prep and final exam

The weekly plan is a 16-week pacing guide. It is only a personal-study structure around the OCW archive.

## Shortcuts

- `/` focuses course search.
- `Esc` closes search and clears the query.

## Attribution And License

Course materials are from MIT OpenCourseWare 18.01SC Single Variable Calculus, Fall 2010.

MIT OCW materials are licensed under Creative Commons BY-NC-SA 4.0:

```text
https://creativecommons.org/licenses/by-nc-sa/4.0/
```

This dashboard is unofficial, for personal studying, and is not endorsed by MIT. It intentionally does not use the MIT logo or present itself as an official MIT site.
