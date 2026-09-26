# Plexys Homework — Corteza backend setup

Prepared on 26 September 2026.

**Execution status:** deployment configuration and UI instructions prepared. Corteza has not been run in this session: the workspace has no Docker runtime, and no existing Corteza instance was supplied. First-run setup, module creation, and sample records remain pending. This document is not evidence that those steps have been completed.

## 1. Version choice

Target image: `cortezaproject/corteza:2024.9.10`.

The [official releases page](https://github.com/cortezaproject/corteza/releases) lists 2024.9.10 as the latest release at the time of preparation. An explicit patch tag makes the intended version clear. Its [changelog](https://docs.cortezaproject.org/corteza-docs/2024.9/changelog/202409/index.html#_2024_9_10) includes fixes for record selectors and select options, which are relevant to this assignment.

PostgreSQL uses `postgres:15`, matching the [official deployment guide](https://docs.cortezaproject.org/corteza-docs/2024.9/devops-guide/index.html#_offline_deployment). This major-version tag can receive patch updates; record the actual PostgreSQL version after starting it.

**Version actually run:** pending. Fill this from `/version` after deployment, rather than treating the configured image tag as proof.

## 2. Start locally

Extract `plexys-corteza-backend.zip`, then open a terminal in the extracted `plexys-corteza-backend` directory. These commands assume Bash, such as WSL.

1. Check that Docker Engine and Compose v2 are available:

   ```bash
   docker version
   docker compose version
   ```

2. Copy the environment template if you do not already have `.env`:

   ```bash
   cp -n .env.example .env
   ```

3. Fill the two blank values in `.env`: `POSTGRES_PASSWORD` and `AUTH_JWT_SECRET`. Generate a separate random hexadecimal value for each, for example by running `openssl rand -hex 32` twice. Hexadecimal avoids URL-encoding issues in the database connection string. These are infrastructure secrets; the admin account is created separately in the browser.

4. Validate, download, and start:

   ```bash
   docker compose config --quiet
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

The configuration serves Corteza's bundled web applications on `127.0.0.1:18080`, waits for the database health check, and uses named volumes for persistent data. PostgreSQL has no published host port. This is a local development configuration.

If startup fails, inspect:

```bash
docker compose logs --tail=100 server db
```

### Database password changes and existing volumes

PostgreSQL only uses `POSTGRES_PASSWORD` to set the database role password when
initializing an empty data volume. Editing `.env` or recreating containers does
not change the password stored in an existing database.

The database health check authenticates through `db` with the configured password.
A mismatch makes the database unhealthy and blocks Corteza startup. A localhost
check would miss this because the image trusts localhost connections.

After changing `POSTGRES_PASSWORD` in `.env`, or to repair a mismatch, run:

```bash
docker compose stop server
docker compose up -d db
# Wait until this reports "accepting connections"; it only checks readiness.
docker compose exec -T db pg_isready -U corteza -d corteza
# Run once PostgreSQL is ready. This preserves the existing database.
docker compose exec -T db psql -U corteza -d corteza -v ON_ERROR_STOP=1 <<'SQL'
\getenv configured_password POSTGRES_PASSWORD
ALTER ROLE corteza PASSWORD :'configured_password';
SQL
docker compose up -d --wait
curl --fail --show-error http://localhost:18080/healthcheck
```

The SQL reads the password from the database container environment without putting
it in the command text. Keep the existing data volume; `docker compose down -v`
would delete it.

## 3. First-run setup in the browser

Open [http://localhost:18080](http://localhost:18080) on the Docker host. Complete the displayed first-run onboarding and create your own account. The official guide describes a sign-up flow: the first account becomes administrator. A separate screen specifically named “setup wizard” may not appear.

Verify that you can open both Admin and Compose / Low Code, and access the namespace builder. Do not put the admin password in the submission.

Capture runtime evidence:

```bash
mkdir -p evidence
curl --fail --show-error http://localhost:18080/version > evidence/corteza-version.txt
curl --fail --show-error http://localhost:18080/healthcheck > evidence/healthcheck.txt
docker compose ps > evidence/containers.txt
docker compose exec -T db psql -U corteza -d corteza -tAc 'SHOW server_version;' > evidence/postgres-version.txt
docker image inspect cortezaproject/corteza:2024.9.10 --format '{{json .RepoDigests}}' > evidence/corteza-image-digest.txt
```

## 4. Configure the application through the UI

Perform all namespace, module, field, page, and record creation in Compose. The package contains no schema import, API provisioning, or record seeding.

Following the [Compose configuration guide](https://docs.cortezaproject.org/corteza-docs/2024.9/integrator-guide/compose-configuration/index.html), open Low Code / Compose and create an enabled namespace:

| Setting | Value |
| --- | --- |
| Name | Plexys Homework |
| Short name | plexys-homework |

Visit it, open **Admin panel → Modules → New Module**, and create **Support Ticket**, with handle `support-ticket`.

Configure these fields. Technical names are proposed here; field labels match the assignment.

| Label | Technical name | Type | Required | Configuration |
| --- | --- | --- | --- | --- |
| Subject | Subject | String | Yes | Single-line |
| Description | Description | String | No | Enable Multi-line; leave rich text off |
| Status | Status | Select / dropdown | Yes | New; In Progress; Resolved; Closed |
| Priority | Priority | Select / dropdown | Yes | Low; Medium; High; Urgent |
| Due Date | DueDate | Date and time | No | Keep both date and time |

For each select option, use the exact text above as **both value and label**. Disable multiple values. For a straightforward required-field check, leave defaults unset. Do not enable date-only, time-only, or past/future restrictions for Due Date.

The [field reference](https://docs.cortezaproject.org/corteza-docs/2024.9/integrator-guide/compose-configuration/field-types.html) documents the Multi-line option and select value/label distinction.

Save the module. Use Corteza's existing system fields: `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, and `ownedBy`. Do not create replacements such as “Created Date” or a custom “Owner” user field. These fields belong to the [system record structure](https://docs.cortezaproject.org/corteza-docs/2024.9/integrator-guide/expr/type-reference.html). An untouched record may have no update timestamp yet.

## 5. Make tickets accessible in Compose

From the module editor, select **Create record page**. In its page builder, include a Record block with all five ticket fields. Save it.

Then create a normal page called **Support Tickets** under **Admin panel → Pages**, open its page builder, and add a Record list block for Support Ticket. Select the columns Subject, Status, Priority, and Due Date. Keep record creation and opening enabled. Save and visit the page.

The record page is needed for the standard create/edit form; the list page gives users a navigation entry. If the generator already created suitable blocks, reuse them. Display created/updated/owner information using the available system-field controls, without adding module fields.

## 6. Bonus: Customer relationship

In the same namespace, create a **Customer** module with handle `customer`:

| Label | Technical name | Type | Required |
| --- | --- | --- | --- |
| Name | name | String | Yes |
| Email | email | Email | No |
| Company | company | String | No |

Create its record page and a Customers list page as above. Through the UI, add this fictional customer:

| Name | Email | Company |
| --- | --- | --- |
| Alex Demo | alex@example.com | Example Workshop |

Return to Support Ticket and add an optional field labelled **Customer**, named `Customer`, of type **Record**. Select Customer as the referenced module and `name` as the record label field. Disable multiple values. Add it to the ticket record page and list.

This models one customer with many tickets, with at most one customer per ticket. The Record field stores the customer record reference; it does not duplicate the customer's contact information.

## 7. Enter sample tickets manually

Use the Support Tickets page and its create-record action. These are example inputs, not existing records:

| Field | Ticket 1 | Ticket 2 |
| --- | --- | --- |
| Subject | Unable to sign in | Invoice download fails |
| Description | Sign-in returns an error after submitting valid credentials. | Leave empty to check the optional field. |
| Status | New | In Progress |
| Priority | High | Medium |
| Due Date | Choose tomorrow at 17:00 in the displayed timezone | Leave empty |
| Customer, if bonus included | Alex Demo | Alex Demo |

Reopen each saved ticket and confirm the values persist. Edit Ticket 1 to Resolved and save; check that the system update metadata changes.

## 8. Completion evidence

Mark these only after performing the checks:

- [ ] Runtime version and PostgreSQL version recorded.
- [ ] Corteza health check succeeds; database is healthy.
- [ ] Admin access verified in the browser.
- [ ] Enabled namespace and Support Ticket module visible.
- [ ] Field labels, types, required flags, and exact select options verified.
- [ ] An attempt to save with missing Subject, Status, or Priority is rejected.
- [ ] Optional fields can be left empty.
- [ ] Description preserves multiple lines.
- [ ] Due Date accepts and retains both date and time.
- [ ] Two tickets created through Compose and reopened successfully.
- [ ] System metadata used without duplicate custom fields.
- [ ] Bonus customer reference saves and opens the correct customer.
- [ ] Records remain after `docker compose restart`.

Capture screenshots of the module fields, each select's configuration, the ticket list, one open ticket with system metadata, and the Customer relationship. Keep them with the runtime evidence. There are no completed screenshots in this package.

Before submission, replace the pending status at the top with the actual run details and completed checks. Explain any unfinished item honestly.

To stop without removing persistent data:

```bash
docker compose stop
```

To resume:

```bash
docker compose up -d
```
