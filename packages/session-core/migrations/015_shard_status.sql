create table if not exists inbox.shard_status (
  shard integer primary key check (shard >= 0),
  configured_runtime text not null,
  observed_runtime text,
  network_policy text not null default 'unknown',
  updated_at timestamptz not null default clock_timestamp()
);
