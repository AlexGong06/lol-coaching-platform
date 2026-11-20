-- 001_initial_schema.sql
--
-- Occupancy, bookings, entitlements, access codes, money ledger, and due work.
--
-- Design note on `reservations`: every occupied range in the system lives in ONE
-- table, because a PostgreSQL exclusion constraint builds a single-table index and
-- can never see a row in another table. A coaching booking and an operator blackout
-- are both just occupied time, so they are both rows here, and one constraint covers
-- overlap between any two of them. A separate `blackouts` table enforced by a trigger
-- would also have a race: a booking and a blackout inserted concurrently would each
-- check the other table, find nothing, and both commit.

BEGIN;

-- ---------------------------------------------------------------- occupancy

CREATE TABLE reservations (
  id          bigserial    PRIMARY KEY,
  kind        text         NOT NULL CHECK (kind IN ('booking', 'blackout')),
  starts_at   timestamptz  NOT NULL,
  ends_at     timestamptz  NOT NULL,

  -- Trigger-maintained. NOT a generated column and NOT an inline constraint
  -- expression: an EXCLUDE constraint builds an index, index expressions must be
  -- IMMUTABLE, and `timestamptz + interval` is only STABLE (adding '1 day' and
  -- '24 hours' differ across a DST boundary). The naive inline form fails at
  -- migration time with "functions in index expression must be marked IMMUTABLE".
  --
  -- NOT NULL is load-bearing, not tidiness: `&&` against NULL yields NULL rather than
  -- true, so a row with a NULL `reserved` is invisible to the exclusion constraint and
  -- double-books its time silently. The trigger always populates it, but a COPY, a
  -- replication tool or one ALTER TABLE ... DISABLE TRIGGER bypasses the trigger and
  -- would otherwise take the system's central invariant with it.
  reserved    tstzrange  NOT NULL,

  -- Whether this row currently occupies its time. The booking state machine is the
  -- only thing that flips it for kind='booking'; blackouts are inserted true and
  -- deleted rather than deactivated.
  holds_slot  boolean      NOT NULL DEFAULT true,

  note        text,
  created_at  timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT reservations_forward CHECK (ends_at > starts_at)
);

CREATE FUNCTION reservations_set_reserved() RETURNS trigger AS $$
BEGIN
  -- Guard before building the range. A BEFORE trigger runs ahead of every CHECK, so
  -- without this a backwards range fails in one of two ways depending on HOW backwards
  -- it is: by more than the gap and tstzrange() itself raises 22000 from inside this
  -- function; by less than the gap and the shifted range is still valid, so the row
  -- reaches reservations_forward and raises 23514. Callers cannot catch one code.
  IF NEW.ends_at <= NEW.starts_at THEN
    RAISE EXCEPTION 'reservation must end after it starts: % to %', NEW.starts_at, NEW.ends_at
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reservations_forward';
  END IF;

  -- The 15-minute inter-session gap lives INSIDE the reserved range, so the database
  -- enforces it. Book 2:00-3:00 and 2:00-3:15 is reserved; nothing may start before
  -- 3:15. This keeps a departing student out of the next session without depending
  -- on slot-generation code being correct.
  NEW.reserved := tstzrange(NEW.starts_at, NEW.ends_at + interval '15 minutes');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER reservations_reserved
  BEFORE INSERT OR UPDATE OF starts_at, ends_at ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_set_reserved();

-- No extension needed: tstzrange has a built-in gist operator class. btree_gist is
-- only required to mix a scalar `WITH =` column into the same EXCLUDE, which this
-- does not do.
ALTER TABLE reservations
  ADD CONSTRAINT reservations_no_overlap
  EXCLUDE USING gist (reserved WITH &&) WHERE (holds_slot);

-- ---------------------------------------------------------------- bookings

CREATE TYPE booking_state AS ENUM (
  'pending_payment',        -- hold + Checkout session exist, money not captured
  'paid',                   -- webhook landed, entitlement created
  'active',                 -- window open
  'completed',              -- window ended, at least one code was issued
  'completed_unfulfilled',  -- window ended, NO code was ever issued: Alex owes a manual refund
  'expired_hold',           -- hold lapsed unpaid (NOT terminal: the race moves out of it)
  'payment_orphaned',       -- paid but the slot was gone: Alex owes a manual refund
  'cancelled'               -- cancelled before window start; no money moves
);

CREATE TYPE sku AS ENUM ('vod_review', 'live_coaching', 'both');

CREATE TABLE bookings (
  id                 bigserial     PRIMARY KEY,
  reservation_id     bigint        NOT NULL UNIQUE REFERENCES reservations(id),
  state              booking_state NOT NULL DEFAULT 'pending_payment',
  sku                sku           NOT NULL,

  student_discord_id text          NOT NULL,
  student_email      text          NOT NULL,
  -- Captured on the booking form in gameName#TAG shape. Validated for shape only,
  -- never against the Riot API at booking time: a dev key that expires every 24
  -- hours must not be able to block a payment.
  riot_id            text          NOT NULL,
  -- Emails render outside a browser and have no viewer to ask, so the student's IANA
  -- zone is stored rather than resolved per-request.
  student_tz         text          NOT NULL,

  price_cents        integer       NOT NULL CHECK (price_cents > 0),
  stripe_session_id  text          UNIQUE,
  hold_expires_at    timestamptz,

  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX bookings_state ON bookings (state);
CREATE INDEX bookings_student ON bookings (student_discord_id);

-- ---------------------------------------------------------------- entitlements

CREATE TYPE entitlement_state AS ENUM (
  'pending',              -- created, window not yet open
  'open',                 -- window current, one code should be live
  'closed',               -- window ended with at least one code issued
  'voided',               -- cancelled before the window opened
  'expired_unfulfilled'   -- window ended and no code was ever issued: the only platform-failure path
);

CREATE TABLE entitlements (
  id          bigserial         PRIMARY KEY,
  booking_id  bigint            NOT NULL UNIQUE REFERENCES bookings(id),
  state       entitlement_state NOT NULL DEFAULT 'pending',
  starts_at   timestamptz       NOT NULL,
  ends_at     timestamptz       NOT NULL,
  created_at  timestamptz       NOT NULL DEFAULT now(),
  updated_at  timestamptz       NOT NULL DEFAULT now(),

  CONSTRAINT entitlements_forward CHECK (ends_at > starts_at)
);

CREATE INDEX entitlements_state ON entitlements (state);

-- ---------------------------------------------------------------- access codes

CREATE TYPE invite_state AS ENUM (
  'issued',   -- code live on the channel
  'deleted',  -- the worker removed it
  'gone'      -- Discord no longer lists it: used, hand-deleted or expired. Not diagnosed.
);

CREATE TABLE access_invites (
  id              bigserial    PRIMARY KEY,
  -- ONE code per booking, ever. No reissue: Discord deletes a max_uses:1 invite the
  -- instant it is used, so reissuing on disappearance would admit a fresh stranger
  -- every poll interval. A plain UNIQUE, not a partial index, because there is never
  -- a second row to allow.
  entitlement_id  bigint       NOT NULL UNIQUE REFERENCES entitlements(id),
  code            text         NOT NULL UNIQUE,
  state           invite_state NOT NULL DEFAULT 'issued',
  max_age_seconds integer      NOT NULL CHECK (max_age_seconds > 0),
  expires_at      timestamptz  NOT NULL,
  -- Telemetry only. Nothing commercial reads it: this bot cannot observe a join.
  consumed_at     timestamptz,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- money ledger

-- Append-only. Money moving backwards NEVER changes a booking state: a dispute on a
-- session delivered three weeks ago lands here and cannot overwrite `completed`,
-- reanimate a closed entitlement or release a slot.
CREATE TYPE money_event_kind AS ENUM (
  'refund_recorded', 'dispute_opened', 'dispute_closed', 'manual_refund_owed'
);

CREATE TABLE money_events (
  id              bigserial        PRIMARY KEY,
  booking_id      bigint           NOT NULL REFERENCES bookings(id),
  kind            money_event_kind NOT NULL,
  amount_cents    integer,
  stripe_event_id text             UNIQUE,
  note            text,
  created_at      timestamptz      NOT NULL DEFAULT now()
);

CREATE INDEX money_events_booking ON money_events (booking_id);

-- ---------------------------------------------------------------- cleanup queue

CREATE TYPE cleanup_state AS ENUM ('queued', 'done');

-- One row per terminal entitlement that could have admitted someone. `done` is an
-- operator self-report and NOTHING VERIFIES IT: the bot cannot see who is in the
-- server, by design. This table records that an obligation existed and that Alex
-- said it was discharged, and no more.
CREATE TABLE member_cleanup (
  id              bigserial     PRIMARY KEY,
  entitlement_id  bigint        NOT NULL UNIQUE REFERENCES entitlements(id),
  discord_id      text          NOT NULL,
  state           cleanup_state NOT NULL DEFAULT 'queued',
  queued_at       timestamptz   NOT NULL DEFAULT now(),
  done_at         timestamptz
);

CREATE INDEX member_cleanup_open ON member_cleanup (state) WHERE state = 'queued';

-- ---------------------------------------------------------------- due work

CREATE TYPE due_work_kind AS ENUM (
  'hold_expiry', 'window_open', 'window_close', 'upload_grant_close', 'ingest_matches'
);

CREATE TABLE due_work (
  id          bigserial     PRIMARY KEY,
  kind        due_work_kind NOT NULL,
  booking_id  bigint        REFERENCES bookings(id) ON DELETE CASCADE,
  due_at      timestamptz   NOT NULL,
  attempts    integer       NOT NULL DEFAULT 0,
  last_error  text,
  claimed_at  timestamptz,
  done_at     timestamptz,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

-- The poller claims with SELECT ... FOR UPDATE SKIP LOCKED over this index.
CREATE INDEX due_work_ready ON due_work (due_at) WHERE done_at IS NULL;
CREATE UNIQUE INDEX due_work_one_per_booking_kind
  ON due_work (booking_id, kind) WHERE booking_id IS NOT NULL;

-- ---------------------------------------------------------------- upload grants

CREATE TYPE grant_state AS ENUM ('open', 'closed');

CREATE TABLE upload_grants (
  id          bigserial   PRIMARY KEY,
  booking_id  bigint      NOT NULL UNIQUE REFERENCES bookings(id),
  state       grant_state NOT NULL DEFAULT 'open',
  -- Gates ISSUING a short-lived upload URL. It cannot authorize or revoke the upload
  -- itself: S3 never consults this database.
  closes_at   timestamptz NOT NULL,
  closed_at   timestamptz,
  object_key  text
);

-- ---------------------------------------------------------------- availability

-- Recurring weekly open ranges in Alex's timezone, edited by direct SQL for this
-- release. One-off unavailability is a reservation with kind='blackout', not a row
-- here, so the database refuses an overlapping booking even if search is wrong.
CREATE TABLE availability_rules (
  id          bigserial PRIMARY KEY,
  weekday     smallint  NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_local time      NOT NULL,
  end_local   time      NOT NULL,
  tz          text      NOT NULL,
  CONSTRAINT availability_forward CHECK (end_local > start_local)
);

-- ---------------------------------------------------------------- webhook dedupe

CREATE TABLE processed_events (
  stripe_event_id text        PRIMARY KEY,
  processed_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- riot ingestion

-- Written by the Go binary. Nothing on the money path reads it.
CREATE TABLE riot_matches (
  match_id    text        PRIMARY KEY,
  puuid       text        NOT NULL,
  riot_id     text        NOT NULL,
  played_at   timestamptz NOT NULL,
  summary     jsonb       NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX riot_matches_riot_id ON riot_matches (riot_id, played_at DESC);

COMMIT;
