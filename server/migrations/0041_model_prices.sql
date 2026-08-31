-- The rate map (planning/metering-plan.md, Stage 3): what one unit of a
-- model's usage costs, in micro-dollars. Deliberately convenient arithmetic:
-- $3 per MILLION tokens == 3 MICRO-dollars per token, so the number a human
-- reads off a pricing page is the number stored here.
--
-- This table holds the STORED rungs — 'admin' (typed in, always wins) and,
-- from Stage 3b, 'provider' (a listPrices wire answer) and 'community' (the
-- fetched map). The descriptor rung and the on-device free rung are runtime
-- data (provider modules), never stored. Precedence is resolved in
-- server/pricing.js when the in-memory rate table is built.
--
-- effective_from is what lets a price change without falsifying history: an
-- edit INSERTS a new row rather than updating, the rate table reads the
-- latest row at or before now, and cost stamped on the meter at write time is
-- never recomputed.
CREATE TABLE model_prices (
  provider        TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  unit            TEXT    NOT NULL,
  micros_per_unit NUMERIC NOT NULL,  -- fractions are real: cache reads at $0.30/M are 0.3
  source          TEXT    NOT NULL,  -- 'admin' | 'provider' | 'community'
  effective_from  BIGINT  NOT NULL,
  fetched_at      BIGINT,            -- learner rungs only; NULL for admin rows
  PRIMARY KEY (provider, model, unit, source, effective_from)
);
