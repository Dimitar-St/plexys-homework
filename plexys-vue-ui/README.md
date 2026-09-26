# Plexys — Vue frontend for Corteza

A Vue 3 + TypeScript support-ticket application with real Corteza API integration.

The interface includes a searchable ticket list, status and priority filters, summary counts, a create/edit dialog, optional customer references, and system record information. It handles loading, empty, validation, permission, expired-session, and API-error states.

**Verification:** the production build and nine automated checks passed. The checks use a local mock of the Corteza API; live Corteza authentication and persistence have not been verified because no running instance was available. The cloud browser blocked the local preview, so visual browser verification remains pending.

## Run the demo

Use Node.js 22.18+ (Node 24 recommended) and npm.

```bash
npm ci
npm run demo
```

Open **http://localhost:5173** and click **Explore the demo**. The demo exercises the same Vue screens, API client, and authentication proxy against an explicit local fixture server. You can search, filter, create, and edit tickets. The banner identifies demo mode; all fixture changes disappear when the process restarts.

The demo is a frontend preview. It does not provision a namespace or satisfy the assignment's requirement to create records through Corteza Compose.

## Connect to Corteza

### 1. Configure the modules manually

Use the previously prepared Corteza + PostgreSQL deployment, or your existing instance. The intended backend version is **Corteza 2024.9.10**. Create the namespace and modules through the Compose builder, as Part 1 requires. This project does not create or modify their schemas.

Support Ticket must use these technical field names (case-sensitive):

| Label | Name | Type | Required | Options |
| --- | --- | --- | --- | --- |
| Subject | `Subject` | String | Yes | Single-line |
| Description | `Description` | String | No | Multi-line |
| Status | `Status` | Select | Yes | `New`, `In Progress`, `Resolved`, `Closed` |
| Priority | `Priority` | Select | Yes | `Low`, `Medium`, `High`, `Urgent` |
| Due Date | `DueDate` | Date and time | No | Date and time enabled |
| Customer, optional bonus | `Customer` | Record | No | References Customer; single value |

Use the exact status and priority text as both the stored option value and displayed label. The form initially selects New and Medium; this does not change the module's own defaults.

For the bonus Customer module, use `name` (required String), `email` (optional Email), and optionally `company` (String). Both modules belong in the same namespace. Create the first customer and one or two tickets through Compose. The Vue app reads existing customer records and lets you select them for tickets.

Do not add custom created/updated/owner fields. The app displays Corteza's `createdAt`, `updatedAt`, and `ownedBy`. It does not generate these values. An existing `updatedAt` is sent back only as the revision timestamp during an update. Owner IDs are shown as IDs; the app does not claim to resolve them to user names.

If your existing module uses different names, adapt the field mapping in `src/domain/tickets.ts` and the customer mapping in `src/api/corteza.ts` before connecting.

### 2. Create an authentication client in Corteza Admin

Open **Admin → System → Auth clients** and create a dedicated client:

| Setting | Value |
| --- | --- |
| Name | Plexys Vue UI |
| Grant type | Authorization code / authenticate users |
| Redirect URI | `http://localhost:5173/auth/callback` |
| Scopes | `profile api` / allow API access on behalf of the signed-in user |

Keep the normal authorization consent behavior. Ensure the user can authorize this client, read the namespace, read/create/update Support Ticket records and their fields, and read Customer records if enabled. Corteza's existing role and record permissions remain authoritative.

Copy the **client ID** (the numeric ID in the client editor URL) and **client secret**. They belong only in the server environment.

### 3. Fill the environment file

```bash
cp .env.example .env
```

Set:

```dotenv
CORTEZA_URL=http://localhost:18080
APP_ORIGIN=http://localhost:5173
PORT=3001
HOST=127.0.0.1
CORTEZA_CLIENT_ID=YOUR_CLIENT_ID
CORTEZA_CLIENT_SECRET=YOUR_CLIENT_SECRET
CORTEZA_NAMESPACE_ID=YOUR_NAMESPACE_ID
CORTEZA_TICKET_MODULE_ID=YOUR_TICKET_MODULE_ID
CORTEZA_CUSTOMER_MODULE_ID=YOUR_CUSTOMER_MODULE_ID
```

Copy namespace and module IDs from the relevant Compose builder URLs. They must be numeric strings, not slugs or handles. Leave `CORTEZA_CUSTOMER_MODULE_ID` empty when the bonus module is absent.

Never rename the secret to `VITE_CORTEZA_CLIENT_SECRET`: `VITE_` variables are exposed to browser code. Do not commit `.env`.

### 4. Start the live integration

```bash
npm run dev
```

Open **http://localhost:5173**, click **Sign in with Corteza**, and complete sign-in on your Corteza instance. Saved tickets go to that instance. Verify one by reopening it in Compose.

Local development uses ports 5173 (Vue/Vite), 3001 (authentication/API proxy), and your Corteza port, normally 18080. Demo mode additionally uses 18081 for its fixture server. Restart after changing `.env`. The development ports are intentionally fixed to keep the redirect URL consistent.

## How requests work

The browser runs Vue. It calls the same-origin `/api/compose/...` route; the included Node server attaches the signed-in user's bearer token and forwards the request to Corteza. There is no second application database or ticket business-logic backend.

| Operation | Request forwarded to Corteza |
| --- | --- |
| List tickets/customers | `GET /api/compose/namespace/{namespaceID}/module/{moduleID}/record/` |
| Read ticket | `GET /api/compose/namespace/{namespaceID}/module/{moduleID}/record/{recordID}` |
| Create ticket | `POST /api/compose/namespace/{namespaceID}/module/{moduleID}/record/` |
| Update ticket | `POST /api/compose/namespace/{namespaceID}/module/{moduleID}/record/{recordID}` |

The API adapter uses Corteza's `response`/`error` envelopes and `values: [{ name, value }]` format. It follows `filter.nextPage` using `pageCursor`, keeps 64-bit IDs as strings, converts local date/time inputs to UTC, and checks error envelopes even when HTTP status is 200. Updates preserve extra record values and omit cleared optional fields from the complete values set.

The proxy uses the authorization-code flow with a dedicated confidential client. Client secrets, access tokens, and refresh tokens remain server-side. The browser receives an HttpOnly session cookie and a CSRF token. The proxy validates OAuth state, rotates session IDs after login, refreshes expiring access tokens, and checks Origin plus CSRF on writes. Routes are restricted to the configured namespace and modules; customer writes and schema operations are unavailable.

Same-origin requests avoid a separate browser-to-Corteza CORS configuration. Signing out ends the **Plexys** session; the separate Corteza login session may still be active.

## Build and serve

```bash
npm run build
```

For a local production-build check, set `APP_ORIGIN=http://localhost:3001`, register `http://localhost:3001/auth/callback` on the Corteza client, and run:

```bash
npm start
```

The Node server serves `dist/` and the API/auth routes on port 3001. For a public deployment, use HTTPS, set `APP_ORIGIN` to the public frontend origin and `CORTEZA_URL` to the reachable HTTPS Corteza URL, and register the matching callback. If using a reverse proxy, route `/auth`, `/app`, and `/api` to this Node server on the same public origin as the Vue assets. Set `NODE_ENV=production`.

This is not a static-only deployment: the authentication proxy must also run. The included session store is in memory, intended for a single-process homework/demo deployment. Restarting it logs users out. Replace it with a shared persistent session store before running multiple replicas. The proxy has an eight-hour session lifetime and a 1,000-session bound.

## Scope and limits

- Includes list, read, create, and update. Ticket deletion and customer creation are outside this frontend's scope.
- Search and filters operate on all records loaded through cursor pagination. A hard 10,000-record limit reports an error instead of silently showing partial results. For larger installations, move search/filter/count handling to Corteza queries and paginate the UI.
- Existing record revision timestamps are forwarded for update conflict handling. Live behavior still needs verification against your configured Corteza instance.
- Due dates display in the browser's timezone; the form identifies that timezone.
- The API body limit is 64 KB.
- Keep the Part 1 Compose UI configuration and screenshots as separate backend evidence.

## Validation

```bash
npm test
npm run build
```

Verified here with Node 24.19.0, Vue 3.5.43, Vite 7.3.6, TypeScript 5.9.3, and vue-tsc 3.3.11. `package-lock.json` pins the resolved dependencies.

Nine automated checks cover invalid OAuth state, session/token isolation, bearer forwarding, cursor parameters, CSRF and route restrictions, create/update payloads, token refresh, logout, 64-bit IDs, optional-field clearing, additional-field preservation, validation, and date conversion. These checks use the fixture; they are not evidence of a running Corteza backend.

Live acceptance steps:

1. Sign in using your dedicated Corteza auth client.
2. Confirm the tickets created in Compose appear in Vue.
3. Create a ticket with all required fields; verify it in Compose.
4. Edit its status and due date; reopen it in both interfaces.
5. Clear Description, Due Date, and Customer; confirm the fields are cleared in Compose.
6. Confirm permission errors are surfaced for a user lacking access.
7. Confirm refresh and logout with your token-lifetime settings.

## Project files

| Path | Purpose |
| --- | --- |
| `src/App.vue` | Ticket list, filters, summaries, session state |
| `src/components/TicketDialog.vue` | Create/edit form and system metadata |
| `src/api/corteza.ts` | Typed requests and cursor pagination |
| `src/domain/tickets.ts` | Record mapping, field validation, dates |
| `server/app.mjs` | OAuth, sessions, restricted API proxy, static serving |
| `server/config.mjs` | Server-only environment configuration |
| `scripts/dev.mjs` | Local development and explicit demo startup |
| `scripts/mock-corteza.mjs` | Demo/test fixture only |
| `tests/` | API/auth and data-mapping checks |

## Primary references

- [Corteza external application authentication](https://docs.cortezaproject.org/corteza-docs/2024.9/integrator-guide/authentication/authenticate-external/index.html)
- [Authentication and supported grant types](https://docs.cortezaproject.org/corteza-docs/2024.9/integrator-guide/authentication/index.html)
- [Compose field types](https://docs.cortezaproject.org/corteza-docs/2024.9/integrator-guide/compose-configuration/field-types.html)
- The official `@cortezaproject/corteza-js@2024.9.10` package was inspected for record endpoint paths, POST update semantics, and the `updatedAt` parameter. The app uses native `fetch` rather than depending on the whole SDK.
- Inspect your running instance's `/api/docs/` for its complete endpoint reference.
