# virtuale.unibo.it API Notes (MCP Recon)

Date: 2026-04-14
Host: https://virtuale.unibo.it
Context: Logged-in browser session via MCP (Chrome)

## What this service appears to be

`virtuale.unibo.it` is Moodle-based. The frontend uses Moodle AJAX endpoints, especially:

- `GET /lib/ajax/service-nologin.php` (public/no-login utility methods)
- `POST /lib/ajax/service.php` (authenticated methods)

A concrete custom method observed in production traffic:

- `local_uniboapi_get_enrolled_courses_unibo`

## Endpoint patterns discovered

## 1) Authenticated AJAX endpoint

`POST /lib/ajax/service.php?sesskey=<sesskey>&info=<method_name_or_batch_label>`

Observed request body format (JSON array):

```json
[
  {
    "index": 0,
    "methodname": "local_uniboapi_get_enrolled_courses_unibo",
    "args": {
      "offset": 0,
      "limit": 0,
      "classification": "all",
      "sort": "fullname",
      "customfieldname": "aa",
      "customfieldvalue": ""
    }
  }
]
```

Observed behavior:

- Requires valid login cookies (`MoodleSession`, shib session cookies, etc.).
- Requires valid `sesskey` query parameter.
- Returns HTTP `200` even on logical failures; errors are in JSON payload (`error: true`).

Typical logical errors:

- Missing/expired login: `servicerequireslogin`
- Invalid sesskey: `invalidsesskey`
- Invalid body format: `codingerror` with `Invalid json in request`

## 2) No-login AJAX endpoint

`GET /lib/ajax/service-nologin.php?info=<...>&cachekey=<...>&args=<json_encoded_array>`

Examples observed:

- `core_get_string`
- `core_output_load_template_with_dependencies`

Batching is supported via `info=<N>-method-calls` plus multiple entries in `args`.

## Method catalog observed so far

From current dashboard load and MCP fetch probes:

- `local_uniboapi_get_enrolled_courses_unibo` (authenticated, custom local plugin namespace)
- `core_courseformat_get_state` (authenticated, course contents/state model)
- `block_panopto_get_content` (authenticated, course Panopto block content)
- `media_videojs_get_language` (authenticated, video player i18n strings)
- `core_get_string` (no-login utility)
- `core_output_load_template_with_dependencies` (no-login utility)
- `core_output_load_fontawesome_icon_system_map` (no-login utility)

Observed `info` query styles:

- Single method: `info=core_get_string`
- Batch shorthand: `info=6-method-calls`, `info=2-method-calls`
- Comma-joined method labels: `info=core_output_load_template_with_dependencies,core_output_load_template_with_dependencies`

Practical note: in `service-nologin.php`, `info` is mostly descriptive/routing metadata; the actual operation definitions are in the JSON `args` array (`methodname` + `args`).

## Session + CSRF model

Both are required for authenticated calls:

- Session cookies (browser-auth context)
- Moodle `sesskey` (anti-CSRF token)

Reliable way from page context:

```js
const sesskey = window?.M?.cfg?.sesskey;
```

## Fetch strategy matrix (tested)

All tests run inside logged-in page context (`https://virtuale.unibo.it/my/`).

1. POST + `credentials: 'include'` + JSON body + `Content-Type: application/json`.
Result: Works.

2. Same as above but with extra `X-Requested-With: XMLHttpRequest`.
Result: Works.

3. POST + `credentials: 'omit'` (no cookies).
Result: Fails logically with `servicerequireslogin`.

4. POST + bad `sesskey`.
Result: Fails logically with `invalidsesskey`.

5. POST with malformed payload encoding (e.g., urlencoded `data=<json>` instead of raw JSON array body).
Result: `codingerror` / invalid JSON request.

6. GET to authenticated endpoint without JSON body.
Result: `codingerror` / invalid JSON request.

7. `service-nologin.php` GET with proper `args` JSON encoded in URL.
Result: Works.

## Minimal working fetch examples

### A) Authenticated method call (`service.php`)

```js
const sesskey = window.M.cfg.sesskey;
const method = 'local_uniboapi_get_enrolled_courses_unibo';

const body = [
  {
    index: 0,
    methodname: method,
    args: {
      offset: 0,
      limit: 10,
      classification: 'all',
      sort: 'fullname',
      customfieldname: 'aa',
      customfieldvalue: ''
    }
  }
];

const res = await fetch(`/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=${method}`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const json = await res.json();
console.log(json);
```

### B) No-login utility method (`service-nologin.php`)

```js
const args = [
  {
    index: 0,
    methodname: 'core_get_string',
    args: {
      stringid: 'loading',
      stringparams: [],
      component: 'core',
      lang: 'en'
    }
  }
];

const q = new URLSearchParams({
  info: 'core_get_string',
  cachekey: '0',
  args: JSON.stringify(args)
});

const res = await fetch(`/lib/ajax/service-nologin.php?${q.toString()}`, {
  credentials: 'include'
});

console.log(await res.json());
```

## Course page APIs: contents, details, and resources

The course page (`/course/view.php?id=<courseid>`) uses authenticated Moodle AJAX calls that are directly useful for an MCP integration.

### 1) Course contents/details model

Method:

- `core_courseformat_get_state`

Working call shape:

```js
const sesskey = window.M.cfg.sesskey;
const method = 'core_courseformat_get_state';

const body = [
  {
    index: 0,
    methodname: method,
    args: { courseid: 74014 }
  }
];

const res = await fetch(`/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=${method}`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const json = await res.json();
const state = JSON.parse(json[0].data); // Important: data is a JSON-encoded string.
```

Observed payload characteristics (course id `74014`):

- `state.course`: course metadata and state key
- `state.section`: list of sections (`id`, `title`, `cmlist`, ...)
- `state.cm`: activity/resource list (name, type, URL, visibility, section)
- Counts observed: `sectionCount=26`, `cmCount=53`

Sample structure observed:

- Section `744365` title `Introduction`, `cmlist: [2314721, 2314722, 2314723]`
- CM `2314723`: name `Introduction - PDF copy`, modname `File`, url `/mod/resource/view.php?id=2314723`

Argument validation notes:

- Empty args -> `invalidparameter`
- `{ courseid: <id> }` -> works
- Adding unsupported args (example tried: `sectionid`) -> `invalidparameter`

### 2) Course block details

Method:

- `block_panopto_get_content`

Working minimal args:

- `{ courseid: 74014 }`

Observed response for this course:

- `This course has not yet been provisioned.`

Validation behavior:

- Empty args -> `invalidparameter`

### 3) Video player localization details

Method:

- `media_videojs_get_language`

Working minimal args:

- `{ lang: 'en' }`

Observed response:

- JSON string map with Video.js UI labels (`Play`, `Pause`, `Fullscreen`, ...)

Validation behavior:

- Empty args -> `invalidparameter`

### 4) Resource/PDF retrieval flow

For course files, the flow observed is:

1. Course state returns a CM URL like `/mod/resource/view.php?id=2314723`
2. Opening that URL redirects to a protected file URL under `pluginfile.php`
3. Final file URL example:
   - `/pluginfile.php/3001131/mod_resource/content/3/Introduction.pdf`

Direct observations:

- Navigation referrer: `/course/view.php?id=74014`
- Final content-type: `application/pdf`
- Fetch with redirect-follow retrieved the PDF blob (`size: 991098` bytes)
- Fetch with `redirect: 'manual'` returned `opaqueredirect` in browser context (expected), so resolve via normal follow/navigation when scraping

### 5) Section pages (HTML fallback)

Endpoint:

- `/course/section.php?id=<sectionid>`

Observed behavior:

- Returns `text/html`
- Contains resource links (`/mod/resource/view.php?id=...`)

MCP implication:

- Prefer `core_courseformat_get_state` for structured data.
- Use section HTML as fallback when AJAX schema changes or method access fails.

## Completed recon tasks

### 1) Additional `service.php` methods by UI area

Observed by navigating key pages and collecting authenticated `service.php` calls:

- Dashboard (`/my/`):
  - `local_uniboapi_get_enrolled_courses_unibo`
- Course main page (`/course/view.php?id=74014`):
  - `core_courseformat_get_state`
  - `block_panopto_get_content`
- Participants (`/user/index.php?id=74014`):
  - `block_panopto_get_content`
- Grades (`/grade/report/user/index.php?id=74014`):
  - `core_courseformat_get_state`
- Forum activity (`/mod/forum/view.php?id=2314721`):
  - `core_courseformat_get_state`

Method seen in prior course-page runtime probe and validated via direct call:

- `media_videojs_get_language`

### 2) Method catalog (schema, sample response, auth, errors)

#### `local_uniboapi_get_enrolled_courses_unibo`

- Endpoint:
  - `POST /lib/ajax/service.php?sesskey=<sesskey>&info=local_uniboapi_get_enrolled_courses_unibo`
- Args schema (observed):
  - `offset: int`
  - `limit: int`
  - `classification: enum(all|inprogress|future|past)`
  - `sort: enum(fullname|shortname|startdate)`
  - `customfieldname: string`
  - `customfieldvalue: string`
- Response sample shape:
  - `[{ error: false, data: { courses: [ { id, fullname, shortname, aa, ... } ] } }]`
- Auth requirements:
  - Logged-in cookies + valid `sesskey`
- Error codes observed:
  - `servicerequireslogin`, `invalidsesskey`, `invalidparameter`, `codingerror`

#### `core_courseformat_get_state`

- Endpoint:
  - `POST /lib/ajax/service.php?sesskey=<sesskey>&info=core_courseformat_get_state`
- Args schema (observed):
  - `courseid: int`
- Response sample shape:
  - `[{ error: false, data: "<json-string>" }]`
  - Parsed JSON has: `course`, `section[]`, `cm[]`
- Auth requirements:
  - Logged-in cookies + valid `sesskey`
- Error codes observed:
  - `invalidparameter` (missing/wrong type)
  - `invalidrecord` (non-existing course)

#### `block_panopto_get_content`

- Endpoint:
  - `POST /lib/ajax/service.php?sesskey=<sesskey>&info=block_panopto_get_content`
- Args schema (observed):
  - `courseid: int`
- Response sample shape:
  - `[{ error: false, data: "This course has not yet been provisioned." }]`
- Auth requirements:
  - Logged-in cookies + valid `sesskey`
- Error codes observed:
  - `invalidparameter`

#### `media_videojs_get_language`

- Endpoint:
  - `POST /lib/ajax/service.php?sesskey=<sesskey>&info=media_videojs_get_language`
- Args schema (observed):
  - `lang: string` (example: `en`, `it`)
- Response sample shape:
  - `[{ error: false, data: "<json-string map of labels>" }]`
- Auth requirements:
  - Logged-in cookies + valid `sesskey`
- Error behavior observed:
  - Missing `lang` -> `invalidparameter`
  - Unknown lang (`zz`) -> success with empty string payload

### 3) Standard Moodle core vs custom Unibo method classification

Heuristic used: Moodle component-style naming prefix.

- Standard/core ecosystem methods:
  - `core_courseformat_get_state`
  - `media_videojs_get_language`
  - `core_get_string` (nologin)
  - `core_output_load_template_with_dependencies` (nologin)
  - `core_output_load_fontawesome_icon_system_map` (nologin)
- Plugin-based but not Unibo-local namespace:
  - `block_panopto_get_content`
- Custom Unibo-local namespace:
  - `local_uniboapi_get_enrolled_courses_unibo`

### 4) Pagination/sorting/filter constraints (validated)

Validated against `local_uniboapi_get_enrolled_courses_unibo`:

- Pagination:
  - `limit=0` -> all results (observed 7)
  - `limit=1`, `limit=5` -> truncates result count accordingly
  - `offset=1, limit=5` -> starts from second item as expected
  - `offset=-1` -> accepted; behavior effectively clamped/no hard error
  - `limit=-1` -> accepted; observed count 1 (non-obvious behavior)
- Sorting:
  - `sort=fullname`, `sort=shortname`, `sort=startdate` -> accepted
  - invalid sort -> `codingerror` with message about invalid sort parameter
- Classification:
  - `all` and `inprogress` -> returned data
  - `future` and `past` -> valid, returned empty set in current account state
  - invalid value -> `invalidparameter`
- Custom field filters:
  - `customfieldname=aa`, `customfieldvalue=2025/26` -> accepted
  - unknown custom field name -> accepted (no filtering effect observed)

### 5) Reusable MCP resolver pipeline

Recommended robust flow:

1. Acquire browser-auth context:
   - Read `sesskey` from `window.M.cfg.sesskey`
   - Use same-origin authenticated requests (`credentials: include`)
2. List user courses:
   - Call `local_uniboapi_get_enrolled_courses_unibo`
3. Resolve course contents/details:
   - Call `core_courseformat_get_state(courseid)`
   - Parse `data` JSON string into object model
4. Resolve resources:
   - For each `cm` with resource URL, open `cm.url` (`/mod/resource/view.php?id=...`)
   - Follow redirect to final `pluginfile.php/...` URL
5. Download content:
   - Fetch or navigate final `pluginfile.php` URL
   - Inspect `content-type` for file handling (PDF, etc.)
6. Error handling strategy:
   - If `servicerequireslogin`: refresh auth session
   - If `invalidsesskey`: refresh page and reacquire `sesskey`
   - If method-level `invalidparameter`: degrade gracefully and fall back to section HTML (`/course/section.php?id=...`)

## Reusable in-page discovery snippet

Run this in browser console (while logged in) to list AJAX endpoints/method labels seen on the current page session:

```js
(() => {
  const urls = performance
    .getEntriesByType('resource')
    .map(e => e.name)
    .filter(u => u.includes('/lib/ajax/'));

  const decoded = urls.map(u => {
    try { return decodeURIComponent(u); } catch { return u; }
  });

  const infos = Array.from(new Set(decoded.map(u => {
    const m = u.match(/(?:[?&]info=)([^&]+)/);
    return m ? m[1] : null;
  }).filter(Boolean)));

  console.log({ count: decoded.length, infos, urls: decoded });
})();
```

## Notes

- Avoid sharing raw response payloads publicly: they contain personal course/user data.
- For automation outside browser context, cookies + sesskey lifecycle handling will be required.
