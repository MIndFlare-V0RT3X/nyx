// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage footer: token accounting from the latest turn.completed event.

import type { Usage } from "../types.js";

export function UsageFooter(props: {
  usage: Usage | null;
  turnActive: boolean;
}): React.ReactElement {
  return (
    <div className="usage">
      {props.turnActive && <span className="pulse">turn running…</span>}
      {props.usage !== null && (
        <span>
          in {props.usage.input_tokens} · out {props.usage.output_tokens}
          {props.usage.reasoning_tokens !== undefined && (
            <> · reasoning {props.usage.reasoning_tokens}</>
          )}
          {props.usage.total_tokens !== undefined && <> · total {props.usage.total_tokens}</>}
        </span>
      )}
      {props.usage === null && !props.turnActive && <span className="dim">no turns yet</span>}
    </div>
  );
}
