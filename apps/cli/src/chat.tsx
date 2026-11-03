// SPDX-License-Identifier: AGPL-3.0-or-later
// The `nyx chat` TUI: an Ink view over the headless chat driver. The driver
// owns every transition (streaming, transcript, approvals, usage); this file
// only renders state and forwards keystrokes — which is why the TUI is fully
// tested without a terminal (see chat-driver tests).

import { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import type { Instance } from "ink";
import type { ChatDriver } from "./chat-driver.js";
import type { ChatEntry, ChatState } from "./chat-state.js";
import { formatDuration } from "./format.js";

const ENTRY_STYLE: Record<ChatEntry["kind"], { color: string; prefix: string }> = {
  user: { color: "cyan", prefix: "❯" },
  assistant: { color: "green", prefix: "●" },
  tool: { color: "gray", prefix: " " },
  denial: { color: "red", prefix: " " },
  approval: { color: "yellow", prefix: " " },
  error: { color: "red", prefix: "✗" },
  info: { color: "blue", prefix: "·" },
};

/** Cap the rendered transcript so long sessions stay responsive. */
const MAX_RENDERED_ENTRIES = 500;

function Transcript({ state }: { state: ChatState }): React.ReactElement {
  const entries = state.entries.slice(-MAX_RENDERED_ENTRIES);
  return (
    <Box flexDirection="column">
      {entries.map((entry, i) => {
        const style = ENTRY_STYLE[entry.kind];
        return (
          <Text key={i} color={style.color}>
            {style.prefix} {entry.text}
          </Text>
        );
      })}
      {state.streaming.length > 0 && (
        <Text color="green">
          ● {state.streaming}
          <Text inverse>▌</Text>
        </Text>
      )}
    </Box>
  );
}

function ApprovalModal({
  state,
  owner_id,
  now,
}: {
  state: ChatState;
  owner_id: string;
  now: number;
}): React.ReactElement | null {
  if (state.pending.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        ⏸ approval required — resolve as {owner_id} (owner)
      </Text>
      {state.pending.map((item, i) => (
        <Text key={item.id} color={i === state.selected ? "yellow" : undefined}>
          {i === state.selected ? "▸" : " "} [{item.risk}] {item.summary} (ttl{" "}
          {formatDuration(item.expires_at - now)})
        </Text>
      ))}
      <Text dimColor>y allow · n deny · ↑↓ select</Text>
    </Box>
  );
}

function InputBox({ state }: { state: ChatState }): React.ReactElement {
  if (state.running) {
    return (
      <Text dimColor>
        ❯ <Text inverse>…</Text> working (ctrl+c interrupts)
      </Text>
    );
  }
  return (
    <Text>
      ❯ {state.input}
      <Text inverse>▌</Text>
    </Text>
  );
}

export function ChatApp({ driver, owner_id }: { driver: ChatDriver; owner_id: string }): React.ReactElement {
  const state = useSyncExternalStore(driver.subscribe, driver.getState);
  const { exit } = useApp();
  const [now, setNow] = useState(() => Date.now());

  // Keep the approval TTL countdown live.
  useEffect(() => {
    if (state.pending.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.pending.length]);

  useEffect(() => {
    if (state.exit_requested) exit();
  }, [state.exit_requested, exit]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      driver.requestExit();
      return;
    }
    if (state.pending.length > 0) {
      if (input === "y" || input === "Y") return driver.approvalKey("y");
      if (input === "n" || input === "N") return driver.approvalKey("n");
      if (key.upArrow) return driver.moveSelection(-1);
      if (key.downArrow) return driver.moveSelection(1);
      return;
    }
    if (key.return) {
      driver.submit();
      return;
    }
    if (key.backspace || key.delete) {
      driver.setInput(state.input.slice(0, -1));
      return;
    }
    if (key.escape) {
      driver.setInput("");
      return;
    }
    if (
      input.length > 0 &&
      !key.ctrl &&
      !key.meta &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.tab
    ) {
      driver.setInput(state.input + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Transcript state={state} />
      <ApprovalModal state={state} owner_id={owner_id} now={now} />
      <Box flexDirection="column" marginTop={1}>
        {state.notice !== null && <Text color="red">{state.notice}</Text>}
        <Text dimColor>
          session {state.session_id} · persona {state.persona_id} · tokens{" "}
          {state.usage ?? "—"} · /exit quits
        </Text>
        <InputBox state={state} />
      </Box>
    </Box>
  );
}

export interface ChatTuiHandle {
  /** Resolves when the app unmounts (exit requested). */
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

/** Render the chat TUI (requires a TTY — main.ts checks before calling). */
export function startChatTui(driver: ChatDriver, owner_id: string): ChatTuiHandle {
  const instance: Instance = render(<ChatApp driver={driver} owner_id={owner_id} />, {
    exitOnCtrlC: false,
  });
  return {
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => instance.unmount(),
  };
}
