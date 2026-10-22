import type { DatabaseSync } from "node:sqlite";

/**
 * Ledger migrations. Each entry runs once, in order, inside a transaction.
 * Append-only tables are enforced with triggers, not by convention.
 */
export const MIGRATIONS: readonly (string | ((db: DatabaseSync) => void))[] = [
  `
  create table meta (key text primary key, value text not null);

  create table contract (
    campaign text not null,
    version integer not null,
    sha text not null,
    mode text not null,
    body text not null,
    created_at text not null,
    primary key (campaign, version)
  );

  create table instance (
    id text primary key,
    campaign text not null,
    version integer not null,
    contract_sha text not null,
    mode text not null,
    seed_repo text not null,
    seed_commit text not null,
    direction text,
    status text not null check (status in ('running', 'paused', 'closed')),
    pause_reason text,
    created_at text not null,
    updated_at text not null,
    foreign key (campaign, version) references contract (campaign, version)
  );

  create table champion (
    instance text not null references instance (id),
    seq integer not null,
    attempt text,
    commit_sha text not null,
    promoted_by text not null,
    promoted_at text not null,
    reopened integer not null default 0,
    primary key (instance, seq)
  );

  create table lane (
    id text primary key,
    instance text not null references instance (id),
    family text,
    status text not null default 'active',
    lane_best_attempt text,
    created_at text not null
  );

  create table attempt (
    id text primary key,
    instance text not null references instance (id),
    lane text,
    origin text not null default 'local',
    parent_ref text not null,
    parent_commit text not null,
    -- The attempt whose commit this one was built on, when there is one (lineage for invalidation).
    parent_attempt text references attempt (id),
    baseline_champion_seq integer,
    commit_sha text not null,
    ref text not null,
    diff_sha text not null,
    normalized_diff_sha text not null,
    lifecycle text not null,
    hypothesis text,
    claim text,
    known_flaws text not null default '[]',
    v0 text,
    -- Set when the attempt itself, or an attempt it derives from, was invalidated. Permanent.
    invalidated_by integer references invalidation (id),
    created_at text not null,
    updated_at text not null
  );
  create index attempt_instance on attempt (instance);
  create index attempt_parent on attempt (parent_attempt);
  create index attempt_commit on attempt (instance, commit_sha);
  create index attempt_norm on attempt (instance, normalized_diff_sha);

  create table job (
    id integer primary key autoincrement,
    attempt text references attempt (id),
    kind text not null,
    state text not null check (state in ('queued', 'leased', 'done', 'failed', 'blocked', 'cancelled')),
    priority integer not null default 100,
    lease_owner text,
    lease_until text,
    fence integer not null default 0,
    expiries integer not null default 0,
    spec text not null default '{}',
    result text,
    created_at text not null,
    updated_at text not null
  );
  create index job_state on job (state, priority, id);

  create table measurement (
    id integer primary key autoincrement,
    job integer not null references job (id),
    -- The lease that wrote it: only the fence that completed the job counts.
    fence integer not null,
    metric text not null,
    cell text not null,
    rep integer not null,
    value real not null
      check (typeof(value) in ('real', 'integer') and value = value and abs(value) < 1e300),
    unit text not null,
    created_at text not null
  );

  create table receipt (
    id text primary key,
    job integer not null references job (id),
    fence integer not null,
    body text not null,
    created_at text not null
  );

  create table verdict (
    id integer primary key autoincrement,
    attempt text not null references attempt (id),
    verdict text not null,
    delta real,
    ci_low real,
    ci_high real,
    guards text not null default '[]',
    depends_on_jobs text not null default '[]',
    reasons text not null,
    judged_by text not null,
    supersedes integer references verdict (id),
    created_at text not null
  );
  create index verdict_attempt on verdict (attempt);

  create table invalidation (
    id integer primary key autoincrement,
    subject_kind text not null check (subject_kind in ('job', 'attempt')),
    subject_id text not null,
    reason text not null,
    actor text not null,
    created_at text not null
  );

  create table directive (
    id integer primary key autoincrement,
    instance text not null,
    author text not null,
    body text not null,
    status text not null default 'active',
    created_at text not null
  );

  create table command (
    id text primary key,
    kind text not null,
    envelope text not null,
    signature text not null,
    accepted integer not null,
    result text not null,
    received_at text not null
  );

  create table import (
    id integer primary key autoincrement,
    kind text not null,
    name text,
    sha256 text,
    commit_sha text,
    source_path text not null,
    stored_path text not null,
    verified_at text not null
  );

  create table export (
    id integer primary key autoincrement,
    through_event integer not null,
    path text not null,
    manifest text not null,
    created_at text not null
  );

  create table event (
    id integer primary key autoincrement,
    at text not null,
    actor text not null,
    kind text not null,
    subject text,
    body text not null
  );

  create table budget_ledger (
    id integer primary key autoincrement,
    instance text not null,
    resource text not null,
    delta real not null,
    reason text not null,
    at text not null
  );

  create table invocation (
    id text primary key,
    instance text,
    lane text,
    role text not null,
    model text,
    tokens_in integer,
    tokens_out integer,
    cost_usd real,
    submissions integer not null default 0,
    outcome text,
    started_at text not null,
    ended_at text
  );

  -- goal mode
  create table goal (
    instance text not null references instance (id),
    id text not null,
    parent text,
    priority integer not null,
    required integer not null,
    verify text not null,
    status text not null default 'untouched'
      check (status in ('untouched', 'attempted', 'verified', 'blocked', 'unmet', 'not_runnable')),
    primary key (instance, id)
  );
  create table goal_check (
    id integer primary key autoincrement,
    instance text not null,
    goal text not null,
    attempt text,
    result text not null check (result in ('met', 'unmet', 'not_runnable', 'error')),
    detail text,
    receipt text,
    created_at text not null
  );

  -- research mode
  create table source (
    id text primary key,
    instance text not null,
    url text not null,
    fetched_at text not null,
    http_status integer,
    sha256 text not null,
    content_path text not null,
    domain text
  );
  create table claim (
    id text primary key,
    instance text not null,
    text text not null,
    quotes text not null,
    sources text not null,
    verified integer not null default 0,
    confidence real,
    created_at text not null
  );
  create table hypothesis (
    id text primary key,
    instance text not null,
    text text not null,
    status text not null default 'open',
    supporting text not null default '[]',
    contradicting text not null default '[]',
    created_at text not null
  );
  create table report_version (
    id integer primary key autoincrement,
    instance text not null,
    body text not null,
    created_at text not null
  );
  create table research_task (
    id text primary key,
    instance text not null,
    lane text,
    body text not null,
    status text not null default 'open',
    created_at text not null
  );

  create trigger event_no_update before update on event begin select raise(abort, 'event is append-only'); end;
  create trigger event_no_delete before delete on event begin select raise(abort, 'event is append-only'); end;
  create trigger verdict_no_update before update on verdict begin select raise(abort, 'verdict is append-only'); end;
  create trigger verdict_no_delete before delete on verdict begin select raise(abort, 'verdict is append-only'); end;
  create trigger measurement_no_update before update on measurement begin select raise(abort, 'measurement is append-only'); end;
  create trigger measurement_no_delete before delete on measurement begin select raise(abort, 'measurement is append-only'); end;
  create trigger receipt_no_update before update on receipt begin select raise(abort, 'receipt is append-only'); end;
  create trigger receipt_no_delete before delete on receipt begin select raise(abort, 'receipt is append-only'); end;
  create trigger contract_no_update before update on contract begin select raise(abort, 'contract versions are immutable'); end;
  create trigger contract_no_delete before delete on contract begin select raise(abort, 'contract versions are immutable'); end;
  create trigger invalidation_no_update before update on invalidation begin select raise(abort, 'invalidation is append-only'); end;
  create trigger invalidation_no_delete before delete on invalidation begin select raise(abort, 'invalidation is append-only'); end;
  create trigger champion_no_delete before delete on champion begin select raise(abort, 'champion history is append-only'); end;
  `,
  // 2: the judge (M2). Measurements name the arm they belong to. Held-out results live in their
  // own table, which never appears in events, snapshots or exports: only promotion reads it.
  `
  alter table measurement add column arm text not null default 'candidate';
  create index measurement_job on measurement (job, fence);

  create table held_out (
    id integer primary key autoincrement,
    job integer not null references job (id),
    fence integer not null,
    attempt text not null references attempt (id),
    pass integer not null,
    detail text not null,
    created_at text not null
  );
  create trigger held_out_no_update before update on held_out begin select raise(abort, 'held_out is append-only'); end;
  create trigger held_out_no_delete before delete on held_out begin select raise(abort, 'held_out is append-only'); end;

  create table build (
    key text primary key,
    repo text not null,
    commit_sha text not null,
    kit_commit text not null,
    ok integer not null,
    manifest text not null,
    created_at text not null
  );
  `,
  // 3: agents (M4). The direction registry, planner epochs and worker trials.
  `
  create table family (
    instance text not null,
    id text not null,
    description text not null,
    status text not null default 'live' check (status in ('live', 'blocked', 'exhausted')),
    created_by text not null,
    created_at text not null,
    primary key (instance, id)
  );
  create table epoch (
    instance text not null,
    n integer not null,
    source text not null check (source in ('planner', 'fallback')),
    planner_tries integer not null,
    planner_valid integer not null,
    raw_violations text not null default '[]',
    assignments text not null,
    notes text,
    started_at text not null,
    ended_at text,
    primary key (instance, n)
  );
  create table trial (
    id text primary key,
    instance text not null,
    lane text not null,
    epoch integer not null,
    family text,
    parent_commit text not null,
    attempt text,
    stopped text,
    turns integer,
    tool_calls integer,
    tokens_in integer,
    tokens_out integer,
    error text,
    started_at text not null,
    ended_at text
  );
  create index trial_lane on trial (instance, lane, epoch);
  alter table attempt add column family text;
  `,
  // 4: goal checks record "inconclusive" (a threshold whose interval straddles the bar) honestly.
  // goal_check never held rows before this version, so it is recreated.
  `
  drop table goal_check;
  create table goal_check (
    id integer primary key autoincrement,
    instance text not null,
    goal text not null,
    attempt text,
    job integer not null,
    commit_sha text not null,
    result text not null check (result in ('met', 'unmet', 'inconclusive', 'not_runnable')),
    detail text not null,
    created_at text not null
  );
  create index goal_check_instance on goal_check (instance, goal);
  create trigger goal_check_no_update before update on goal_check begin select raise(abort, 'goal_check is append-only'); end;
  create trigger goal_check_no_delete before delete on goal_check begin select raise(abort, 'goal_check is append-only'); end;
  `,
  // 5: research mode (M4). The tables from version 1 were never used; they are rebuilt with what
  // the fetcher, the claim check and the report need.
  `
  drop table source;
  drop table claim;
  drop table hypothesis;
  drop table report_version;
  drop table research_task;
  create table source (
    id text primary key,
    instance text not null,
    url text not null,
    final_url text not null,
    domain text not null,
    fetched_at text not null,
    http_status integer not null,
    content_type text,
    bytes integer not null,
    sha256 text not null,
    title text,
    raw_path text not null,
    text_path text not null,
    fetched_by text not null
  );
  create unique index source_url on source (instance, url);
  create index source_sha on source (instance, sha256);
  create table claim (
    id text primary key,
    instance text not null,
    lane text,
    question integer,
    text text not null,
    quotes text not null,
    verified integer not null,
    problems text not null default '[]',
    confidence real,
    created_at text not null
  );
  create table note (
    id integer primary key autoincrement,
    instance text not null,
    lane text,
    text text not null,
    sources text not null default '[]',
    created_at text not null
  );
  create table hypothesis (
    id text primary key,
    instance text not null,
    lane text,
    text text not null,
    supporting text not null default '[]',
    contradicting text not null default '[]',
    created_at text not null
  );
  create table report_section (
    instance text not null,
    name text not null,
    body text not null,
    updated_by text not null,
    updated_at text not null,
    primary key (instance, name)
  );
  create table report_version (
    id integer primary key autoincrement,
    instance text not null,
    kind text not null check (kind in ('digest', 'final')),
    body text not null,
    created_at text not null
  );
  create table research_query (
    id integer primary key autoincrement,
    instance text not null,
    lane text,
    query text not null,
    allowed integer not null,
    reason text,
    created_at text not null
  );
  `,
  // 6: M4 review fixes. Each trial gets its own token (stored hashed), which binds API calls to
  // the trial's instance and lane and stops working when the trial ends. Jobs record when they
  // were leased, for the device-hours budget.
  `
  alter table trial add column token_sha text;
  create index trial_token on trial (token_sha);
  alter table job add column leased_at text;
  `,
  // 7: M5. Directive sets replace their author's previous set; epochs record the directives in
  // force. Audits (an audit can block, never pass), propagated candidates, the subjective-goal
  // review panel and "not possible" proposals. Decisions are written once.
  `
  alter table directive add column superseded_at text;
  alter table epoch add column directives text not null default '[]';
  alter table attempt add column flaws_cleared_by text;

  -- One audit per confirmation of an attempt: if the champion moves while a result waits and the
  -- attempt is confirmed again, it gets a new audit against the new champion.
  create table audit (
    id integer primary key autoincrement,
    attempt text not null references attempt (id),
    confirm_job integer not null,
    instance text not null,
    trigger text not null check (trigger in ('absolute', 'ratio', 'known_flaws', 'adversarial_checklist')),
    reason text not null,
    expected_seq integer,
    requested_at text not null,
    decision text check (decision in ('clear', 'block', 'needs_owner')),
    reasons text,
    citations text,
    auditor text,
    decided_at text
  );
  create unique index audit_attempt_job on audit (attempt, confirm_job);
  create trigger audit_decided_once before update on audit
    when old.decision is not null begin select raise(abort, 'audit decision is final'); end;
  create trigger audit_no_delete before delete on audit begin select raise(abort, 'audit is append-only'); end;

  create table propagation (
    attempt text primary key references attempt (id),
    instance text not null,
    source_unit text not null,
    source_instance text not null,
    source_seq integer not null,
    tree text not null,
    created_at text not null,
    result text,
    decided_at text
  );

  create table review (
    id integer primary key autoincrement,
    instance text not null,
    goal text not null,
    attempt text,
    commit_sha text not null,
    package text not null,
    requested_at text not null,
    panel text,
    panel_result text check (panel_result in ('review_passed', 'review_failed')),
    panel_at text,
    owner_decision text check (owner_decision in ('accepted', 'rejected')),
    owner_note text,
    owner_at text
  );
  create unique index review_goal_commit on review (instance, goal, commit_sha);

  create table conclusion (
    id integer primary key autoincrement,
    instance text not null,
    kind text not null check (kind in ('not_possible')),
    evidence text not null,
    proposed_at text not null,
    decision text check (decision in ('accepted', 'rejected')),
    note text,
    decided_at text
  );
  `,
  // 8: an instance may run with its worker agents off (a judge-only run, such as a kit's dry
  // run on the unmodified project): the judge calibrates, validates and judges submissions.
  `
  alter table instance add column agents integer not null default 1;
  `,
  // 9: the owner's messages to agent sessions (message_agent), kept until delivered.
  `
  create table agent_message (
    id integer primary key autoincrement,
    instance text not null,
    target text not null,
    text text not null,
    issued_by text not null,
    created_at text not null,
    delivered_at text,
    delivered_to text
  );
  create index agent_message_pending on agent_message (instance, target) where delivered_at is null;
  `,
  // 10: the owner's names (2026-10-15): an instance is a run, a unit is a rig. Every column
  // named instance (or source_instance) becomes run (source_run), source_unit becomes
  // source_rig, the instance table becomes run (indexes, triggers and references follow), and
  // job specs name their run. Events are append-only and keep the names they were recorded
  // with; readers see them under the new names (core/names.ts).
  (db) => {
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const cols = db.prepare(`pragma table_info(${name})`).all() as { name: string }[];
      for (const c of cols) {
        if (c.name === "instance") db.exec(`alter table ${name} rename column instance to run`);
        if (c.name === "source_instance")
          db.exec(`alter table ${name} rename column source_instance to source_run`);
        // measurement.unit is a metric's unit and keeps its name.
        if (c.name === "source_unit")
          db.exec(`alter table ${name} rename column source_unit to source_rig`);
      }
    }
    if (tables.some((t) => t.name === "instance")) db.exec("alter table instance rename to run");
    db.exec(
      "update job set spec = json_set(json_remove(spec, '$.instance'), '$.run', json_extract(spec, '$.instance')) where json_extract(spec, '$.instance') is not null",
    );
  },
  // 11: a run's own promotion policy, chosen when it is assigned (null: the rig's default).
  `
  alter table run add column promotion text check (promotion in ('auto', 'owner_approval'));
  `,
  // 12: research findings (a worker's conclusion, checked against verified claims) and the
  // record of the files each lane wrote in its research folder.
  `
  create table finding (
    id text primary key,
    run text not null,
    lane text,
    text text not null,
    summary text not null,
    why_it_matters text not null,
    supporting text not null default '[]',
    supported integer not null,
    problems text not null default '[]',
    created_at text not null
  );
  create table research_file (
    id integer primary key autoincrement,
    run text not null,
    lane text not null,
    trial text,
    path text not null,
    change text not null check (change in ('written', 'removed')),
    bytes integer,
    sha256 text,
    recorded_at text not null
  );
  create index research_file_run on research_file (run, lane, path);
  `,
  // 13: the owner's messages get read receipts and can be kept in force. A message can be read by
  // several readers (each lane, the planner, the teachers, the auditor, the review panel); a
  // message kept in force goes into every new trial's brief until it is unkept. Deliveries made
  // before this version become reads by the trial's lane (or the planner) at the time they
  // were made, and messages to the advisors become reads by each advisor role; nothing else is
  // assumed read.
  (db) => {
    db.exec(`
      alter table agent_message add column keep integer not null default 0;
      alter table agent_message add column unkept_at text;
      create table agent_message_read (
        id integer primary key autoincrement,
        message integer not null references agent_message (id),
        reader text not null,
        trial text,
        read_at text not null
      );
      create index agent_message_read_by on agent_message_read (message, reader);
    `);
    const delivered = db
      .prepare(
        "select id, target, delivered_at, delivered_to from agent_message where delivered_at is not null",
      )
      .all() as { id: number; target: string; delivered_at: string; delivered_to: string | null }[];
    const laneOf = db.prepare("select lane from trial where id = ?");
    const insert = db.prepare(
      "insert into agent_message_read (message, reader, trial, read_at) values (?, ?, ?, ?)",
    );
    for (const m of delivered) {
      const to = m.delivered_to ?? "";
      if (to === "planner") {
        insert.run(m.id, "planner", null, m.delivered_at);
        continue;
      }
      const trial = to.startsWith("trial:") ? to.slice("trial:".length) : null;
      const lane =
        (trial ? (laneOf.get(trial) as { lane: string } | undefined)?.lane : undefined) ??
        (m.target.startsWith("lane-") ? m.target : undefined);
      if (lane) insert.run(m.id, lane, trial, m.delivered_at);
    }
    // Messages to the advisors were shown in their briefs for a day under the earlier rules and
    // never marked: each advisor role has read them, so none is given again after the upgrade.
    const advisors = db
      .prepare("select id, created_at from agent_message where target = 'advisors'")
      .all() as { id: number; created_at: string }[];
    for (const m of advisors)
      for (const role of ["teachers", "auditor", "panel"])
        insert.run(m.id, role, null, m.created_at);
  },
  // 14: each run's experiment queue (goal 064): what to try, who added it and why, its state,
  // its place among the queued ones (0 first; null once it left the order or before it was
  // queued), and what became of it: the lane and trial that took it, the attempt and result, or
  // why it was dropped. Every change to a row is written with its event, in one transaction.
  `
  create table experiment (
    id text primary key,
    run text not null,
    title text not null,
    details text not null default '',
    family text not null default '',
    why text not null default '',
    added_by text not null,
    state text not null check (state in ('proposed', 'queued', 'assigned', 'done', 'dropped')),
    place integer,
    lane text,
    trial text,
    attempt text,
    result text,
    dropped_by text,
    dropped_why text,
    from_run text,
    from_id text,
    created_at text not null,
    updated_at text not null
  );
  create index experiment_run on experiment (run, state, place);
  create index experiment_trial on experiment (trial);
  `,
  // 15: field notes (goal 065): what the workers, the planner and the advisors write down as they
  // work, each with its kind, who wrote it and what it is about. Notes are append-only: no agent
  // edits or deletes one. Each run also keeps the background the owner picked from past research
  // when starting it, in order, with where each item came from.
  `
  create table journal_note (
    id integer primary key autoincrement,
    run text not null,
    by text not null,
    kind text not null
      check (kind in ('observation', 'decision', 'surprise', 'question', 'lesson', 'note')),
    text text not null check (length(text) between 1 and 2000),
    about_type text
      check (about_type in ('experiment', 'attempt', 'source', 'claim', 'finding', 'round', 'trial', 'message')),
    about_id text,
    lane text,
    trial text,
    at text not null,
    check ((about_type is null) = (about_id is null))
  );
  create index journal_note_run on journal_note (run, id);
  create index journal_note_lane on journal_note (run, lane, id);
  create trigger journal_note_no_update before update on journal_note begin select raise(abort, 'field notes are append-only'); end;
  create trigger journal_note_no_delete before delete on journal_note begin select raise(abort, 'field notes are append-only'); end;

  create table run_briefing (
    run text not null references run (id),
    seq integer not null,
    text text not null,
    from_campaign text not null,
    from_run text not null,
    from_kind text not null,
    from_ref text not null,
    primary key (run, seq)
  );
  create trigger run_briefing_no_update before update on run_briefing begin select raise(abort, 'a run''s briefing is fixed'); end;
  create trigger run_briefing_no_delete before delete on run_briefing begin select raise(abort, 'a run''s briefing is fixed'); end;
  `,
  // 16: every field note says what it is about. A note whose writer named nothing is about its
  // run (about_type 'run', about_id the run's id): the notes kept before say so too, and none
  // leaves it empty any more. The table is copied whole into its new form; no note is lost.
  `
  create table journal_note_v16 (
    id integer primary key autoincrement,
    run text not null,
    by text not null,
    kind text not null
      check (kind in ('observation', 'decision', 'surprise', 'question', 'lesson', 'note')),
    text text not null check (length(text) between 1 and 2000),
    about_type text not null
      check (about_type in ('run', 'experiment', 'attempt', 'source', 'claim', 'finding', 'round', 'trial', 'message')),
    about_id text not null,
    lane text,
    trial text,
    at text not null
  );
  insert into journal_note_v16 (id, run, by, kind, text, about_type, about_id, lane, trial, at)
    select id, run, by, kind, text, coalesce(about_type, 'run'), coalesce(about_id, run), lane, trial, at
    from journal_note order by id;
  drop table journal_note;
  alter table journal_note_v16 rename to journal_note;
  create index journal_note_run on journal_note (run, id);
  create index journal_note_lane on journal_note (run, lane, id);
  create trigger journal_note_no_update before update on journal_note begin select raise(abort, 'field notes are append-only'); end;
  create trigger journal_note_no_delete before delete on journal_note begin select raise(abort, 'field notes are append-only'); end;
  `,
  // 17: model usage (goal 075) is one model_call event for each call, many more events than
  // before: the reads of one kind of event (a run's newest of a kind, the knowledge base's part)
  // use an index instead of reading every event.
  `
  create index event_kind on event (kind, subject);
  `,
  // 18: an experiment whose trial never really tried it (the provider failed, the harness
  // restarted, the run was paused) goes back to the queue as the same row (goal 079): how many
  // times it came back, and why. A tried experiment keeps why its trial ended (its cause).
  `
  alter table experiment add column cause text;
  alter table experiment add column returns integer not null default 0;
  `,
  // 19: what a run asks the owner about (goal 079): hands-off by default, each switch asks.
  `
  alter table run add column ask_owner text;
  `,
];
