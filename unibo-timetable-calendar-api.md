# Unibo Timetable API: How to Fetch a Calendar

Date: 2026-04-14
Source analyzed: https://github.com/FrancescoBonzi/UniboCalendar (branch `master`)

## Goal

Given a Unibo degree-course URL, fetch timetable events from Unibo and turn them into a calendar feed (ICS or similar).

## End-to-end flow used by UniboCalendar

## 1) Start from the course page on unibo.it

Input example:

- `https://www.unibo.it/it/didattica/corsi-di-studio/corso/2025/xxxx`

In `src/model.js`, `getTimetableUrlGivenUniboUrl` does:

1. `GET` the Unibo course page HTML
2. Parse first `.social-contact ul li ul li p a`
3. Extract the timetable site URL (`timetable_url`), usually on `https://corsi.unibo.it/...`

## 2) Discover available curricula

In `getCurriculaGivenCourseUrl`:

1. Reuse `timetable_url`
2. Derive `type` from URL segment index `3`
3. Map `type` to language path using:

- `magistralecu`, `magistrale`, `laurea` -> `orario-lezioni`
- `singlecycle`, `1cycle`, `2cycle` -> `timetable`

4. Build endpoint:

- `{timetable_url}/{LANGUAGE[type]}/@@available_curricula`

5. `GET` it as JSON

Example shape:

- `https://corsi.unibo.it/laurea/clei/orario-lezioni/@@available_curricula`

## 3) Fetch timetable HTML for chosen year/curriculum

In `getTimetable`:

1. Build URL:

- `{timetable_url}/{LANGUAGE[type]}?anno={year}&curricula={curriculum}`

2. `GET` page HTML
3. Parse teaching IDs and labels from:

- `#insegnamenti-popup ul li input` (lecture IDs)
- `#insegnamenti-popup ul li label` (human labels)

These IDs are later used to filter events.

## 4) Fetch real timetable events JSON

In `getICalendarEvents`, once enrollment is stored, UniboCalendar builds:

- `https://corsi.unibo.it/{type}/{course}/{LANGUAGE[type]}/@@orario_reale_json?anno={year}&curricula={curriculum}&calendar_view=`

Notes:

- The code appends `&calendar_view=` explicitly.
- It previously considered appending `insegnamenti=...` in URL, but current code instead fetches full JSON and filters locally.

## 5) Filter only selected lectures

For each event `l` returned by `@@orario_reale_json`, UniboCalendar keeps it if either condition is true:

- selected lecture set contains `l.extCode.split('|')[0]`
- selected lecture set contains full `l.extCode`

This handles both raw and pipe-separated external codes.

## 6) Transform events into calendar entries

For each filtered JSON item:

- `start`: `new Date(l.start)`
- `end`: `new Date(l.end)`
- `location`: first classroom from `l.aule[0].des_risorsa + ", " + l.aule[0].des_indirizzo` if present
- `url`: `l.teams` (encoded) if present
- `organizer`: from `l.docente` (converted into email-like form in the project)

Then `src/icalendar.js` serializes events into ICS (`BEGIN:VCALENDAR ... END:VCALENDAR`).

## Practical endpoint summary

If you just need raw events, the key endpoint is:

- `https://corsi.unibo.it/{type}/{course}/{orario-lezioni|timetable}/@@orario_reale_json?anno={year}&curricula={curriculum}&calendar_view=`

Where:

- `type` is one of `laurea`, `magistrale`, `singlecycle`, etc.
- `{orario-lezioni|timetable}` depends on type mapping above
- `course` is the course slug from the `corsi.unibo.it` URL

## Minimal JavaScript example (raw events)

```js
import fetch from "node-fetch";

const LANGUAGE = {
  magistralecu: "orario-lezioni",
  magistrale: "orario-lezioni",
  laurea: "orario-lezioni",
  singlecycle: "timetable",
  "1cycle": "timetable",
  "2cycle": "timetable"
};

async function fetchUniboEvents({ type, course, year, curriculum }) {
  const langPath = LANGUAGE[type];
  if (!langPath) {
    throw new Error(`Unsupported type: ${type}`);
  }

  const url = `https://corsi.unibo.it/${type}/${course}/${langPath}/@@orario_reale_json?anno=${encodeURIComponent(year)}&curricula=${encodeURIComponent(curriculum)}&calendar_view=`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from timetable endpoint`);
  }

  return res.json();
}
```

## Important caveats

- HTML selectors on Unibo pages are brittle: if frontend markup changes, discovery steps may break.
- Validate policy/compliance before large-scale scraping.
- Avoid publishing personal timetable data.
- If curricula are missing (`value: undefined`), the repository treats the course as unavailable for timetable extraction.

## Code references in analyzed repository

- `src/model.js`
  - `getTimetableUrlGivenUniboUrl`
  - `getCurriculaGivenCourseUrl`
  - `getTimetable`
  - `getICalendarEvents`
- `src/controller.js`
  - `/course`, `/get_curricula_given_course`, `/get_ical`
- `src/public/scripts/home.js`
  - frontend calls for area->course->curricula flow
- `src/icalendar.js`
  - ICS serialization
