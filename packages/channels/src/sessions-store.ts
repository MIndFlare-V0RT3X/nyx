// SPDX-License-Identifier: AGPL-3.0-or-later
// Channel → session mapping. Session key = sha256(channel:channel_user_id:thread_id)
// (§4.3). The mapping is persisted in SQLite so restarts reattach conversations
// to their sessions; /new replaces the mapping, /fork replaces it with the child.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface ChannelSessionMapping {
  channel_key: string;
  session_id: string;
  updated_at: number;
}

export function channelKey(channel: string, channel_user_id: string, thread_id?: string): string {
  return createHash("sha256")
    .update(`${channel}:${channel_user_id}:${thread_id ?? ""}`)
    .digest("hex");
}

const DDL = `CREATE TABLE IF NOT EXISTS channel_sessions (
  channel_key TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

/** 2.0.1: create the channel-session table on any handle (shared unified db). */
export function ensureChannelSessionsTable(db: Database.Database): void {
  db.exec(DDL);
}

export class ChannelSessionStore {
  private readonly stmts: {
    get: Database.Statement;
    put: Database.Statement;
    delete: Database.Statement;
  };

  constructor(db: Database.Database) {
    db.exec(DDL);
    this.stmts = {
      get: db.prepare(
        "SELECT channel_key, session_id, updated_at FROM channel_sessions WHERE channel_key = ?",
      ),
      put: db.prepare(
        `INSERT INTO channel_sessions (channel_key, channel, channel_user_id, thread_id, session_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      ),
      delete: db.prepare("DELETE FROM channel_sessions WHERE channel_key = ?"),
    };
  }

  get(channel: string, channel_user_id: string, thread_id?: string): ChannelSessionMapping | null {
    const row = this.stmts.get.get(channelKey(channel, channel_user_id, thread_id)) as
      { channel_key: string; session_id: string; updated_at: number } | undefined;
    return row ?? null;
  }

  put(
    channel: string,
    channel_user_id: string,
    thread_id: string | undefined,
    session_id: string,
    now: number = Date.now(),
  ): void {
    this.stmts.put.run(
      channelKey(channel, channel_user_id, thread_id),
      channel,
      channel_user_id,
      thread_id ?? "",
      session_id,
      now,
    );
  }
}
