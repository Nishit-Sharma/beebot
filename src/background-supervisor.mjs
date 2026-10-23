import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
/** In-app supervision only. Never installs a service or retries an uncertain action. */
export function createBackgroundSupervisor({
  directory,
  stream,
  canStream,
  poll,
  drain,
  clock = Date.now,
}) {
  const db = new DatabaseSync(join(directory, "supervisor.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY,data TEXT)");
  let state;
  try {
    state = JSON.parse(
      db.prepare("SELECT data FROM state WHERE id=1").get()?.data ??
        '{"desiredStream":false,"failures":0,"nextReconnectAt":0,"nextPollAt":0}',
    );
    if (
      !state ||
      typeof state.desiredStream !== "boolean" ||
      ![state.failures, state.nextReconnectAt, state.nextPollAt].every(
        Number.isFinite,
      )
    )
      throw Error("InvalidSupervisorState");
  } catch {
    db.close();
    throw Error(
      "StoredSupervisorStateUnreadable: supervisor.sqlite was kept unchanged. Stop the app and restore a known-good backup or seek recovery help; discovery and streaming were not enabled.",
    );
  }
  let busy = false,
    closed = false;
  const save = () =>
    db
      .prepare(
        "INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(JSON.stringify(state));
  const status = () => ({
    ...state,
    discoveryEnabled: state.discoveryEnabled === true,
    busy,
    location: "inside this running Mac app",
    systemServiceInstalled: false,
  });
  async function tick() {
    if (closed || busy) return;
    busy = true;
    try {
      const now = clock();
      if (state.desiredStream && !canStream()) {
        state.desiredStream = false;
        stream.stop();
        state.lastEvent = "Selected scope ended; stream stopped";
      }
      if (state.desiredStream) {
        if (stream.status().started) {
          if (stream.status().connected) {
            state.failures = 0;
            state.nextReconnectAt = 0;
          }
        } else if (now >= state.nextReconnectAt) {
          try {
            stream.start();
            state.lastEvent =
              "Scoped stream start requested; disconnected events require snapshot recovery";
          } catch {
            state.lastEvent = "Scoped stream unavailable";
          }
          state.failures++;
          state.nextReconnectAt =
            now + Math.min(60000, 1000 * 2 ** Math.min(state.failures - 1, 6));
        }
      }
      if (now >= state.nextPollAt) {
        state.nextPollAt = now + 60000;
        try {
          const result = await poll({
            discoveryEnabled: state.discoveryEnabled === true,
          });
          state.lastPollAt = clock();
          state.lastPollResult = result ?? null;
          state.pollError = result?.failed
            ? "Some selected reads failed; stale data is not fresh authority"
            : null;
        } catch {
          state.pollError =
            "Selected snapshot refresh failed; cached data is not fresh execution authority";
        }
      }
      if (closed) return;
      try {
        await drain();
        state.workerError = null;
      } catch {
        state.workerError =
          "Queue drain failed; durable task state retained, no uncertain action replay";
      }
      state.lastTickAt = clock();
      if (!closed) save();
    } finally {
      busy = false;
      if (closed) db.close();
    }
  }
  return {
    tick,
    status,
    setDiscoveryEnabled(enabled) {
      if (typeof enabled !== "boolean") throw Error("InvalidDiscoverySetting");
      state.discoveryEnabled = enabled;
      state.nextPollAt = 0;
      save();
    },
    startStream() {
      if (!canStream())
        throw Error("SelectAndFollowMappedBeeConversationFirst");
      state.desiredStream = true;
      state.nextReconnectAt = 0;
      save();
      return tick();
    },
    stopStream() {
      state.desiredStream = false;
      stream.stop();
      state.lastEvent = "Owner stopped stream";
      save();
    },
    close() {
      if (closed) return;
      closed = true;
      stream.stop();
      if (!busy) db.close();
    },
  };
}
