# KCA Indian Talent Scan — Admin Dashboard

React + Tailwind CSS admin frontend for the KCA Indian Talent Scan (ITS) event
management app. This is **Instruction Block 3**: the admin dashboard shell
plus three fully-built pages — Login, Year Setup, and Events — talking to a
Node.js + Express API over JWT.

Hosted target: `talentscan.kcabah.com` (admin routes live under `/admin`).

## Stack

- React 19 + Vite
- Tailwind CSS v4 (KCA navy `#1F4E79` / gold `#C55A11` theme, see `src/index.css`)
- React Router v7 (client-side routing, `BrowserRouter`)
- lucide-react icons

## Getting started

```bash
npm install
cp .env.example .env   # point VITE_API_BASE_URL at your backend if not localhost:4000
npm run dev
```

The app expects the Express API at `http://localhost:4000` by default. Change
`VITE_API_BASE_URL` in `.env` to point elsewhere (e.g. a staging API).

```bash
npm run build     # production build to dist/
npm run preview   # serve the production build locally
npm run lint       
```

## Auth model

Per the spec, **the JWT token is held only in React state** (`AuthContext`,
`src/context/AuthContext.jsx`) — never in `localStorage`/`sessionStorage`/cookies.
A page refresh signs the user out by design. Every API call attaches
`Authorization: Bearer <token>` automatically via `src/api/client.js`.

`ProtectedRoute` (`src/components/auth/ProtectedRoute.jsx`) redirects
unauthenticated users to `/admin/login`, and also accepts an optional
`allowedRoles` prop for role-gated pages (e.g. the future Chairman-only
Awards screen).

## Pages built in this block

| Route | File | Notes |
|---|---|---|
| `/admin/login` | `src/pages/Login.jsx` | Username/password, show/hide toggle, inline error state |
| `/admin/config/year` | `src/pages/YearConfig.jsx` | All `year_config` variables, asset uploads, Publish/Freeze actions |
| `/admin/events` | `src/pages/Events.jsx` | Searchable/sortable/paginated list, full edit drawer, cancel flow |

The sidebar (`src/components/layout/Sidebar.jsx`) already lists the full
planned nav (Registrations, Judges, Schedule, Awards, Finance) as disabled
"Soon" items so the roadmap is visible — wire each one up as its own
instruction block lands.

## Year Setup page details

- Age groups G1–G5: DOB-from/DOB-to per group, nothing hard-coded per year.
- Grades (A/B/C by default, but the rows are data — add/remove if a future
  year needs more): min % threshold + grade points each, enforced strictly
  descending (A > B > C).
- Rank points (1st/2nd/3rd) and a default participation bonus, all editable.
- Divergence threshold (%) with the exact helper copy from the brief, plus a
  live worked example, and the tiebreaker scale max.
- Branding uploads (KCA logo, sponsor logo, result PDF template) via
  drag-and-drop, each uploaded immediately to
  `POST /api/year-config/upload`.
- Teacher name deadline (date), editable even after the deadline passes.
- **Publish Config** runs client-side validation, `PUT`s the full config,
  then calls `POST /api/year-config/publish` — behind a confirmation dialog.
- **Freeze Registrations** is a separate, independently-confirmed action that
  calls `POST /api/year-config/freeze-registrations`.

## Events page details

- Table is fetched once from `GET /api/events` and then searched / sorted /
  paginated entirely client-side (the ~63-event catalogue is small enough
  that this avoids over-specifying a server-side query contract — swap to
  server params later via the same `eventsApi.list(token, params)` signature
  if the catalogue grows).
- **Add event** / **Edit** open the same slide-over drawer
  (`src/pages/events/EventEditDrawer.jsx`) with Details / Criteria / Slots
  tabs. The Slots tab only appears when **Time-slot mode** is switched on.
- Criteria editor enforces the "max scores sum to 100" rule live, with a
  colour-coded badge, and blocks save until it's exactly 100.
- Slots editor computes `chest_no_start` per slot live, continuous across
  all slots in the event, from an editable base — chest numbers themselves
  are never assigned here (that happens on the day, per the spec).
- **Cancel event** requires a typed reason and is logged; copy reminds the
  admin that affected participants get one swap window once published.

## API contract this build expects

All endpoints are namespaced under `VITE_API_BASE_URL` (default
`http://localhost:4000`). Adjust `src/api/client.js` if your backend differs
— it's the single source of truth for every request shape used by the UI.

```
POST   /api/auth/login                       { username, password } -> { token, user: { name, role } }

GET    /api/year-config?year=YYYY            -> year_config object (404 if none saved yet)
PUT    /api/year-config                      <- full year_config object
POST   /api/year-config/upload               <- multipart: field, file -> { url, name }
POST   /api/year-config/publish              <- full year_config object
POST   /api/year-config/freeze-registrations

GET    /api/events                            -> Event[] (or { items, total })
POST   /api/events                           <- Event -> created Event
PUT    /api/events/:id                       <- Event -> updated Event
POST   /api/events/:id/cancel                 { reason }
PUT    /api/events/:id/slots                  { slots }
```

`Event` shape used by the form (`src/pages/events/constants.js`):

```js
{
  id, code, name, category, type: 'individual' | 'team',
  age_groups: ['G1', 'G3'], gender: 'any' | 'boys' | 'girls',
  description, status: 'active' | 'cancelled',
  criteria: [{ id, label, max_score }],   // max_score sums to 100
  time_slot_mode: boolean, chest_no_base: number,
  slots: [{ id, label, reporting_time, capacity }],
}
```

## Notes for the next instruction block

- `AdminLayout` (`src/components/layout/AdminLayout.jsx`) is the shared shell
  every future admin page should use — just pass `title`, `subtitle`, and
  optional header `actions`.
- Toast notifications are global via `useToast()` — no need to build another
  notification system per page.
- `ConfirmDialog` and `Drawer` are generic and reusable for the Chest
  Numbers, Scoring, and Judges pages coming next.
