/** The tables of control's knowledge base (store/kb.ts). */
export const KB_SCHEMA = `
create table if not exists kb_item (
  id integer primary key autoincrement,
  -- From kb_cursor.item_seq, given again on every update: what a rig's sync reads after.
  seq integer not null,
  campaign text not null,
  rig text not null,
  -- The rig's ledger: after a reset, its new runs' items never mix with the old ones.
  ledger text not null,
  run text not null,
  kind text not null,
  ref text not null,
  title text not null,
  body text not null,
  by text not null,
  url text,
  sub text,
  meta text not null default '{}',
  at text not null,
  updated_at text not null,
  unique (rig, ledger, run, kind, ref)
);
create index if not exists kb_item_campaign on kb_item (campaign, kind);
create index if not exists kb_item_seq on kb_item (campaign, seq);
create table if not exists kb_run (
  rig text not null,
  ledger text not null,
  run text not null,
  campaign text not null,
  primary key (rig, ledger, run)
);
-- seq: the seq in control's events table of the last event indexed from it, before the apply of
-- the events stream fed the knowledge base (it no longer moves); item_seq: the last seq given to
-- an item or a grant's copy, which the rigs' cursors count.
create table if not exists kb_cursor (
  id integer primary key check (id = 1),
  seq integer not null,
  item_seq integer not null
);
insert or ignore into kb_cursor (id, seq, item_seq) values (1, 0, 0);
create table if not exists kb_read (
  campaign text not null,
  reads text not null,
  granted_by text not null,
  granted_at text not null,
  primary key (campaign, reads)
);
-- A grant gives the granted folder's items seqs of their own for the grantee, so a run at work,
-- whose cursor is past those items' seqs, still receives the folder it may now read.
create table if not exists kb_grant_item (
  campaign text not null,
  reads text not null,
  item integer not null,
  seq integer not null,
  primary key (campaign, reads, item)
);
create index if not exists kb_grant_item_seq on kb_grant_item (campaign, seq);
-- What the folders were built with: the reading's version (see READING).
create table if not exists kb_meta (key text primary key, value text not null);
`;
